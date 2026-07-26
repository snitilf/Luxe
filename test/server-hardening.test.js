// Decision D2: framing defenses and same-origin guards on the state-changing routes, plus the
// privacy modes on the state directory. These are the behaviors a hostile page the user simply
// visits would exercise, so every case here is written from that attacker's point of view.
//
// What this file does NOT claim: that artifact JavaScript is untrusted. It is trusted to the
// level of the agent that wrote it and can send feedback through the documented
// window.luxe API (see the trust model note in README.md). The guards here are about a
// foreign page driving your session, which is a different threat.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LUXE_HOST = "127.0.0.1";
process.env.LUXE_LINK_HOST = "127.0.0.1";

import { ensureStateDir, STATE_DIR_MODE, STATE_FILE_MODE, supportsPosixFileModes } from "../src/paths.js";
import { SessionStore } from "../src/session-store.js";
import { serve } from "../src/server.js";
import { saveWhiteboard } from "../src/whiteboard-store.js";

const HOSTILE_ORIGIN = "https://evil.example";
const HOSTILE_REFERER = "https://evil.example/trap.html";

async function startServer() {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-hardening-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Demo</h1></body></html>");
  await writeFile(path.join(dir, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((res) => res.json());
  return {
    dir,
    base,
    artifact,
    key: opened.key,
    server,
    sameOrigin: { "content-type": "application/json", origin: base },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// A page the user visits must not be able to frame the session chrome: it carries the session
// key, the conversation, the End control, and the private artifact it hosts.
test("the session page refuses to be framed at all", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.base}/session/${ctx.key}`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'");
  } finally {
    await ctx.close();
  }
});

// The artifact is legitimately framed by the same-origin chrome, so it gets 'self' rather than
// 'none' - 'none' here would blank the review surface.
test("artifact routes allow same-origin framing and nothing else", async () => {
  const ctx = await startServer();
  try {
    const index = await fetch(`${ctx.base}/artifact/${ctx.key}/index.html`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.equal(index.headers.get("x-frame-options"), "SAMEORIGIN");

    const asset = await fetch(`${ctx.base}/artifact/${ctx.key}/logo.svg`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-security-policy"), "frame-ancestors 'self'");

    const redirect = await fetch(`${ctx.base}/artifact/${ctx.key}`, { redirect: "manual" });
    assert.equal(redirect.headers.get("content-security-policy"), "frame-ancestors 'self'");
  } finally {
    await ctx.close();
  }
});

test("live artifact assets reject symlinks that escape the real artifact root", async () => {
  const ctx = await startServer();
  const outside = await mkdtemp(path.join(tmpdir(), "luxe-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "outside secret");
    await symlink(outside, path.join(ctx.dir, "linked-assets"), "junction");

    const escaped = await fetch(`${ctx.base}/artifact/${ctx.key}/linked-assets/secret.txt`);
    const legitimate = await fetch(`${ctx.base}/artifact/${ctx.key}/logo.svg`);

    assert.equal(escaped.status, 403);
    assert.doesNotMatch(await escaped.text(), /outside secret/);
    assert.equal(legitimate.status, 200);
  } finally {
    await ctx.close();
    await rm(outside, { recursive: true, force: true });
  }
});

// Upstream deliberately applies no CSP to artifact content, and artifacts are author-written
// pages that must render as authored. The framing header must not have grown other directives.
test("the artifact CSP constrains framing only", async () => {
  const ctx = await startServer();
  try {
    const res = await fetch(`${ctx.base}/artifact/${ctx.key}/index.html`);
    const csp = res.headers.get("content-security-policy");

    assert.equal(csp, "frame-ancestors 'self'");
    for (const directive of ["script-src", "style-src", "default-src", "connect-src", "img-src"]) {
      assert.doesNotMatch(csp, new RegExp(directive));
    }
  } finally {
    await ctx.close();
  }
});

// Every state-changing route that uses isSameOriginOrHeaderlessRequest. The first five are the
// routes D2 named; the last two are the file-addressed twins that made the keyed guards
// cosmetic while they were unguarded. The session key is sha256(artifact path).slice(0,16)
// with no secret in it, so a page that knows the path can address the session either way: a
// hostile Origin on /api/end ended the review and tripped shutdownIfNoLiveSessions, and
// /api/sessions with {reopen:true} revived a session the human had deliberately ended.
const GUARDED_WRITES = [
  { name: "shutdown", path: () => "/shutdown", body: () => ({}) },
  { name: "prompts", path: (ctx) => `/api/${ctx.key}/prompts`, body: () => ({ prompts: [], domSnapshot: "x" }) },
  { name: "layout-warnings", path: (ctx) => `/api/${ctx.key}/layout-warnings`, body: () => ({ layout_warnings: [] }) },
  { name: "agent-reply", path: (ctx) => `/api/${ctx.key}/agent-reply`, body: () => ({ text: "hi" }) },
  { name: "keyed end", path: (ctx) => `/api/${ctx.key}/end`, body: () => ({}) },
  { name: "file-addressed end", path: () => "/api/end", body: (ctx) => ({ file: ctx.artifact }) },
  { name: "sessions reopen", path: () => "/api/sessions", body: (ctx) => ({ file: ctx.artifact, reopen: true }) },
];

for (const route of GUARDED_WRITES) {
  test(`${route.name} rejects cross-origin browser provenance`, async () => {
    const ctx = await startServer();
    try {
      const url = `${ctx.base}${route.path(ctx)}`;
      const payload = JSON.stringify(route.body(ctx));

      const crossOrigin = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: HOSTILE_ORIGIN },
        body: payload,
      });
      assert.equal(crossOrigin.status, 403);
      assert.match((await crossOrigin.json()).error, /^cross-origin /);

      const crossOriginReferer = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", referer: HOSTILE_REFERER },
        body: payload,
      });
      assert.equal(crossOriginReferer.status, 403);

      // Still alive and still serving: the rejection must not have been a crash.
      assert.equal((await fetch(`${ctx.base}/health`)).status, 200);
    } finally {
      await ctx.close();
    }
  });

  // `Origin: null` is what a sandboxed iframe, a `data:` document, and some redirected posts
  // send. It is a real value, not an absent header, so it must take the rejection branch and
  // not the header-less acceptance branch. This is the case that separates the two: a guard
  // written as `origin !== expected && origin` would wave it straight through.
  test(`${route.name} rejects Origin: null (the sandboxed-iframe case)`, async () => {
    const ctx = await startServer();
    try {
      const res = await fetch(`${ctx.base}${route.path(ctx)}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "null" },
        body: JSON.stringify(route.body(ctx)),
      });

      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /^cross-origin /);
      assert.equal((await fetch(`${ctx.base}/health`)).status, 200);
    } finally {
      await ctx.close();
    }
  });

  // A fresh server per call: /shutdown and the end routes are terminal, so a second request
  // would hit a socket the first one just closed.
  test(`${route.name} accepts same-origin requests`, async () => {
    const ctx = await startServer();
    try {
      // The browser chrome: same-origin fetch, Origin present and matching.
      const res = await fetch(`${ctx.base}${route.path(ctx)}`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify(route.body(ctx)),
      });
      assert.equal(res.status, 200);
    } finally {
      await ctx.close();
    }
  });

  test(`${route.name} accepts requests with no browser provenance`, async () => {
    const ctx = await startServer();
    try {
      // The CLI: Node's fetch sends neither Origin nor Referer. This must keep working, which
      // is why these routes use isSameOriginOrHeaderlessRequest and not isSameOriginRequest -
      // the strict guard fails closed here and would 403 every CLI call.
      const res = await fetch(`${ctx.base}${route.path(ctx)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route.body(ctx)),
      });
      assert.equal(res.status, 200);
    } finally {
      await ctx.close();
    }
  });
}

// The two guards differ in exactly one case, and that difference is the whole reason there are
// two of them. Pin it from both sides in one place, with the contrast in the name, so a future
// refactor that "unifies" them fails here loudly instead of silently 403-ing the CLI (if the
// strict guard wins) or opening the whiteboard writes to header-less callers (if the lenient
// one does). See isSameOriginRequest / isSameOriginOrHeaderlessRequest in src/server.js.
test("header-less requests: whiteboard writes fail CLOSED, CLI-reachable writes stay OPEN", async () => {
  const ctx = await startServer();
  try {
    const headerless = { method: "POST", headers: { "content-type": "application/json" } };

    // Browser-only routes: no Origin and no Referer means no provenance to trust, so 403.
    const channel = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      ...headerless,
      body: JSON.stringify({ token: "whatever" }),
    });
    assert.equal(channel.status, 403, "whiteboard-channel must keep failing closed");
    assert.equal((await channel.json()).error, "cross-origin whiteboard channel request rejected");

    const feedbackFiles = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      ...headerless,
      body: JSON.stringify({ scene: null }),
    });
    assert.equal(feedbackFiles.status, 403, "whiteboard feedback-files must keep failing closed");

    const whiteboardPut = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: null }),
    });
    assert.equal(whiteboardPut.status, 403, "whiteboard PUT must keep failing closed");

    // CLI-reachable routes: the same header-less request is how `luxe` itself talks, so 200.
    // /shutdown and the end routes are terminal, so this half covers the non-terminal ones and
    // the per-route "accepts requests with no browser provenance" cases cover the rest.
    const prompts = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      ...headerless,
      body: JSON.stringify({ prompts: [], domSnapshot: "x" }),
    });
    assert.equal(prompts.status, 200, "the CLI posts prompts with no Origin and no Referer");

    const sessions = await fetch(`${ctx.base}/api/sessions`, {
      ...headerless,
      body: JSON.stringify({ file: ctx.artifact, reopen: true }),
    });
    assert.equal(sessions.status, 200, "`luxe <file> --reopen` posts with no Origin and no Referer");
  } finally {
    await ctx.close();
  }
});

// The bypass the /api/:key/end guard was supposed to close, driven end to end from the
// attacker's side: a page that only knows the artifact path must not be able to end the
// session, and must not be able to bring a user-ended one back.
test("a hostile page cannot end a session or revive a user-ended one through the file-addressed routes", async () => {
  const ctx = await startServer();
  try {
    const hostile = { "content-type": "application/json", origin: HOSTILE_ORIGIN };

    const forcedEnd = await fetch(`${ctx.base}/api/end`, {
      method: "POST",
      headers: hostile,
      body: JSON.stringify({ file: ctx.artifact }),
    });
    assert.equal(forcedEnd.status, 403);

    // The session is untouched and the server is still up: neither endSession nor
    // shutdownIfNoLiveSessions ran.
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200);
    const stillOpen = await fetch(`${ctx.base}/session/${ctx.key}`);
    assert.equal(stillOpen.status, 200);

    // A second live session keeps the server up past the end below: /api/:key/end runs
    // shutdownIfNoLiveSessions(), and this test still has assertions to make afterwards.
    const keepAlive = path.join(ctx.dir, "keep-alive.html");
    await writeFile(keepAlive, "<!doctype html><html><body><h1>Keep alive</h1></body></html>");
    await fetch(`${ctx.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: keepAlive }),
    });

    // Now the human ends the reviewed session for real, from the same-origin chrome.
    const userEnd = await fetch(`${ctx.base}/api/${ctx.key}/end`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: "{}",
    });
    assert.equal(userEnd.status, 200);

    // And the hostile page cannot undo that decision with a cross-origin reopen.
    const forcedReopen = await fetch(`${ctx.base}/api/sessions`, {
      method: "POST",
      headers: hostile,
      body: JSON.stringify({ file: ctx.artifact, reopen: true }),
    });
    assert.equal(forcedReopen.status, 403);

    // The user-ended state survived: a plain open still refuses to revive it.
    const reopened = await fetch(`${ctx.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: ctx.artifact }),
    }).then((res) => res.json());
    assert.equal(reopened.status, "user-ended");
  } finally {
    await ctx.close();
  }
});

// /shutdown is the one guarded route with no session and a terminal side effect, so it gets its
// own before/after check that the 403 really did stop the shutdown.
test("a cross-origin shutdown leaves the server running", async () => {
  const ctx = await startServer();
  try {
    const rejected = await fetch(`${ctx.base}/shutdown`, { method: "POST", headers: { origin: HOSTILE_ORIGIN } });
    assert.equal(rejected.status, 403);
    assert.equal((await fetch(`${ctx.base}/health`)).status, 200);

    const accepted = await fetch(`${ctx.base}/shutdown`, { method: "POST" });
    assert.equal(accepted.status, 200);
    await ctx.server.done;
  } finally {
    await ctx.close();
  }
});

// The snapshot is the only page context the agent gets, and after Phase 3 it has no visible
// surface at all, so an end-to-end proof that a Send still carries it matters more, not less.
test("a feedback POST still delivers a populated domSnapshot to the agent", async () => {
  const ctx = await startServer();
  try {
    const queued = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: [{ uid: "1", prompt: "tighten this", selector: "h1", tag: "annotation", text: "Demo" }],
        domSnapshot: 'uid=1 h1 "Demo"',
      }),
    });
    assert.equal(queued.status, 200);

    const feedback = await fetch(`${ctx.base}/api/poll?file=${encodeURIComponent(ctx.artifact)}&timeoutMs=5000`).then(
      (res) => res.json(),
    );

    assert.equal(feedback.status, "feedback");
    assert.equal(feedback.dom_snapshot, 'uid=1 h1 "Demo"');
    assert.equal(feedback.prompts[0].prompt, "tighten this");
  } finally {
    await ctx.close();
  }
});

// state.json holds every project's prompts, chat history and DOM snapshots in one shared file.
// POSIX modes are the control; on Windows they are not the ACL that matters and chmod is a
// no-op, so the assertions are skipped rather than pretended.
test("the state directory and state file are owner-only", { skip: !supportsPosixFileModes() }, async () => {
  const previous = process.env.LUXE_STATE_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-state-modes-"));
  const stateDir = path.join(dir, "state");
  process.env.LUXE_STATE_DIR = stateDir;
  try {
    await ensureStateDir();
    assert.equal((await stat(stateDir)).mode & 0o777, STATE_DIR_MODE);

    const store = new SessionStore(path.join(stateDir, "state.json"));
    await store.writeState({ sessions: {} });
    assert.equal((await stat(path.join(stateDir, "state.json"))).mode & 0o777, STATE_FILE_MODE);

    // Whiteboard sidecars live under the same root; the tree is owner-only too.
    await saveWhiteboard(stateDir, "0123456789abcdef", 0, { sourceHash: "h", scene: null });
    const sidecar = path.join(stateDir, "whiteboards", "0123456789abcdef");
    assert.equal((await stat(sidecar)).mode & 0o777, STATE_DIR_MODE);
    assert.equal((await stat(path.dirname(sidecar))).mode & 0o777, STATE_DIR_MODE);
  } finally {
    if (previous === undefined) delete process.env.LUXE_STATE_DIR;
    else process.env.LUXE_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// A directory or file left behind by an older version (or loosened by hand) is tightened on
// the next CLI start rather than staying world-readable forever. Every path the README claims
// is tightened is listed here, and the list must stay in step with that sentence - server.log
// was created 0600 but never re-tightened, so an existing 0644 log survived every startup
// while the README said otherwise.
test(
  "startup tightens a pre-existing loose state dir, state.json, server.log and whiteboards",
  { skip: !supportsPosixFileModes() },
  async () => {
    const { chmod } = await import("node:fs/promises");
    const previous = process.env.LUXE_STATE_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "luxe-state-loose-"));
    const stateDir = path.join(dir, "state");
    const whiteboards = path.join(stateDir, "whiteboards");
    const sessionBoard = path.join(whiteboards, "0123456789abcdef");
    process.env.LUXE_STATE_DIR = stateDir;
    try {
      await mkdir(sessionBoard, { recursive: true });
      await writeFile(path.join(stateDir, "state.json"), '{"sessions":{}}\n');
      // openSync(log, "a", 0o600) does not re-apply the mode to a log that already exists, so
      // this is the realistic starting state after an upgrade.
      await writeFile(path.join(stateDir, "server.log"), "started\n");
      await chmod(stateDir, 0o755);
      await chmod(path.join(stateDir, "state.json"), 0o644);
      await chmod(path.join(stateDir, "server.log"), 0o644);
      await chmod(whiteboards, 0o755);
      await chmod(sessionBoard, 0o755);

      await ensureStateDir();

      assert.equal((await stat(stateDir)).mode & 0o777, STATE_DIR_MODE);
      assert.equal((await stat(path.join(stateDir, "state.json"))).mode & 0o777, STATE_FILE_MODE);
      assert.equal((await stat(path.join(stateDir, "server.log"))).mode & 0o777, STATE_FILE_MODE);
      assert.equal((await stat(whiteboards)).mode & 0o777, STATE_DIR_MODE);
      assert.equal((await stat(sessionBoard)).mode & 0o777, STATE_DIR_MODE);
    } finally {
      if (previous === undefined) delete process.env.LUXE_STATE_DIR;
      else process.env.LUXE_STATE_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ensureStateDir runs on every CLI invocation, including in a brand-new state dir where
// nothing but the directory exists yet. The tighten pass must stay best-effort there: a
// missing state.json, a missing server.log and a missing whiteboards/ are all normal.
test(
  "startup on a fresh state dir tightens what exists and ignores what does not",
  {
    skip: !supportsPosixFileModes(),
  },
  async () => {
    const previous = process.env.LUXE_STATE_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "luxe-state-fresh-"));
    const stateDir = path.join(dir, "state");
    process.env.LUXE_STATE_DIR = stateDir;
    try {
      await ensureStateDir();
      assert.equal((await stat(stateDir)).mode & 0o777, STATE_DIR_MODE);
    } finally {
      if (previous === undefined) delete process.env.LUXE_STATE_DIR;
      else process.env.LUXE_STATE_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
