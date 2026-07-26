import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LUXE_HOST = "127.0.0.1";
process.env.LUXE_LINK_HOST = "127.0.0.1";

import {
  createWhiteboardChannelToken,
  createWhiteboardFrameHtml,
  isValidWhiteboardChannelToken,
  isWhiteboardWriteApiPath,
  serve,
} from "../src/server.js";
import { mermaidSourceHash } from "../src/mermaid-source.js";

const ARTIFACT_HTML = `<!doctype html><html><body>
<h1>Demo</h1>
<pre class="mermaid">flowchart TD
  A[Start] --&gt; B{Ready?}</pre>
<pre class="mermaid">sequenceDiagram
  CLI-&gt;&gt;Server: poll</pre>
</body></html>`;

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function startWhiteboardServer() {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-wb-server-"));
  const assetsDir = path.join(dir, "whiteboard-assets");
  await mkdir(path.join(assetsDir, "fonts", "Excalifont"), { recursive: true });
  await writeFile(path.join(assetsDir, "whiteboard.js"), "// fake bundle\n");
  await writeFile(path.join(assetsDir, "whiteboard.css"), "body{}\n");
  await writeFile(path.join(assetsDir, "fonts", "Excalifont", "Excalifont-Regular.woff2"), "fake-font");
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, ARTIFACT_HTML);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    whiteboardAssetsDir: assetsDir,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((res) => res.json());
  return {
    dir,
    // The session store canonicalizes the artifact path, and on macOS the temp
    // dir is a symlink, so kept files land under the resolved path.
    realDir: await realpath(dir),
    base,
    key: opened.key,
    server,
    sameOrigin: { "content-type": "application/json", origin: base },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("isWhiteboardWriteApiPath matches only whiteboard write routes", () => {
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/12/feedback-files"), true);
  // The kept-copy route carries a full-resolution PNG data URL, so it needs the
  // 20 MB body limit exactly like the other whiteboard writes.
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/3/save-to-machine"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/3/save-to-elsewhere"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/prompts"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/9999"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/BAD/whiteboard/0"), false);
  // The index pattern is the canonical decimal form the routes accept, so no
  // path the routes will reject can claim the 20 MB body cap.
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/007"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0x10"), false);
  assert.equal(isWhiteboardWriteApiPath("/whiteboard-frame"), false);
});

test("createWhiteboardFrameHtml loads only whiteboard-assets resources", () => {
  const html = createWhiteboardFrameHtml("channel-token");
  assert.match(html, /<link rel="stylesheet" href="\/whiteboard-assets\/whiteboard\.css">/);
  assert.match(html, /<script src="\/whiteboard-assets\/whiteboard\.js"><\/script>/);
  assert.match(html, /__luxeWhiteboardChannelToken="channel-token"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("whiteboard confirms sanitized links inside the frame", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/whiteboard-frame.css", import.meta.url), "utf8");

  assert.doesNotMatch(frame, /window\.confirm/);
  assert.match(frame, /setAttribute\("role", "dialog"\)/);
  assert.match(frame, /setAttribute\("aria-modal", "true"\)/);
  assert.match(frame, /setAttribute\("aria-label", "Open external link"\)/);
  assert.match(frame, /event\.key === "Escape"/);
  assert.match(frame, /event\.key !== "Tab"/);
  assert.match(frame, /window\.open\(safe, "_blank", "noopener,noreferrer"\)/);
  assert.match(css, /\.wb-link-confirm/);
});

// Fullscreen-first is a scoped rewrite, not a subtraction. Every one of these
// was built unconditionally for both placements upstream, and each is load
// bearing on its own: without the stale banner, edits made against an older
// diagram merge silently; without the fallback banner, an image-only scene
// looks broken rather than intentional; without setLocked, the teardown flush
// races the user's next stroke.
test("the fullscreen rewrite keeps every guard the two-placement frame had", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");

  assert.match(frame, /id: "wbNote"/, "the note field is gone");
  assert.match(frame, /id: "wbFallbackBanner"/, "the image-fallback banner is gone");
  assert.match(frame, /id: "wbStaleBanner"/, "the stale-source banner is gone");
  assert.match(frame, /id: "wbStatus"/, "the status line is gone");
  assert.match(frame, /id: "wbQueue"/, "the queue-feedback control is gone");
  assert.match(frame, /id: "wbSaveToMachine"/, "the save-to-machine control is missing");
  assert.match(frame, /Re-convert \(discard saved edits\)/, "the stale re-convert choice is gone");
  assert.match(frame, /Keep editing saved scene/, "the stale keep-editing choice is gone");
  assert.match(frame, /state\.setLocked\?\.\(true\)/, "the teardown flush no longer locks the canvas");
  assert.match(frame, /state\.setLocked\?\.\(false\)/, "a failed teardown save no longer unlocks the canvas");

  // And the inline placement really is gone, rather than merely unreachable.
  assert.doesNotMatch(frame, /luxe-whiteboard:maximize/);
  assert.doesNotMatch(frame, /"inline"/);
  assert.doesNotMatch(frame, /wbFullscreen/);
});

// "Save to machine" is the one control whose busy state is cleared by a reply
// from the chrome rather than by anything inside the frame. Without a bound on
// the wait, an overlay torn down mid-flight leaves the button disabled for the
// life of the frame with no way back.
test("the save-to-machine control cannot stay disabled waiting for a reply that never comes", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");

  assert.match(frame, /const SAVE_TO_MACHINE_TIMEOUT_MS = \d+;/, "the save-to-machine wait is unbounded");
  assert.match(
    frame,
    /state\.saveToMachineTimer = window\.setTimeout\(\s*\(\) => \{\s*resetSaveButton\(\);\s*showStatus\(/,
    "the timeout must restore the control and say so",
  );
  // And the reply path clears it, so a save that does answer leaves no timer
  // behind to fire a false failure over the next save.
  assert.match(
    frame,
    /function resetSaveButton\(\) \{\s*window\.clearTimeout\(state\.saveToMachineTimer\);/,
    "the reply path must clear the timeout",
  );
});

test("the frame is light only, and gets its theme through the Excalidraw prop alone", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/whiteboard-frame.css", import.meta.url), "utf8");

  assert.doesNotMatch(frame, /\bdark\b/i);
  // `--dark-fill` is the cocoa token, not a dark mode. Comments are allowed to
  // say why the dark layer was deleted; the rules themselves may not.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replaceAll("--dark-fill", "--cocoa");
  assert.doesNotMatch(rules, /\bdark\b/i);
  assert.doesNotMatch(rules, /data-luxe-whiteboard-theme/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(frame, /theme: "light"/);
  // The canvas background is a token, applied at mount, never persisted.
  assert.match(frame, /viewBackgroundColor: LUXE_WHITEBOARD_CANVAS_BACKGROUND/);
  assert.doesNotMatch(frame, /#ffffff/);
  // One token source: the shell stylesheet imports the tokens instead of
  // carrying a palette of its own.
  assert.match(css, /@import "\.\/luxe-tokens\.css";/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

// The queue-feedback PNG is what the agent and the user actually look at, so it
// must land on Luxe paper rather than Excalidraw's default white.
test("both exported PNGs fall back to the Luxe canvas, never to white", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");

  assert.match(frame, /exportBackground: true/);
  assert.match(frame, /viewBackgroundColor: appState\.viewBackgroundColor \|\| LUXE_WHITEBOARD_CANVAS_BACKGROUND/);
  // One exporter, used by both the queue path and the keep path.
  assert.equal((frame.match(/exportToBlob\(/g) || []).length, 1);
  assert.match(frame, /const pngDataUrl = await exportScenePng\(\);/);
});

test("whiteboard channel tokens are signed and short lived", () => {
  const secret = Buffer.from("whiteboard-test-secret");
  const now = 1_700_000_000_000;
  const token = createWhiteboardChannelToken(secret, now);
  assert.equal(isValidWhiteboardChannelToken(token, secret, now), true);
  assert.equal(isValidWhiteboardChannelToken(`${token}x`, secret, now), false);
  assert.equal(isValidWhiteboardChannelToken(token, secret, now + 5 * 60_000 + 1), false);
});

test("GET /api/:key/mermaid-sources extracts ordered, entity-decoded sources with hashes", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const data = await fetch(`${ctx.base}/api/${ctx.key}/mermaid-sources`).then((res) => res.json());
    assert.equal(data.sources.length, 2);
    assert.equal(data.sources[0].index, 0);
    assert.equal(data.sources[0].source, "flowchart TD\n  A[Start] --> B{Ready?}");
    assert.equal(data.sources[0].hash, mermaidSourceHash("flowchart TD\n  A[Start] --> B{Ready?}"));
    assert.equal(data.sources[1].source, "sequenceDiagram\n  CLI->>Server: poll");
  } finally {
    await ctx.close();
  }
});

test("whiteboard scene round-trips through PUT and GET", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const empty = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`).then((res) => res.json());
    assert.equal(empty.whiteboard, null);

    const scene = { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "dark" }, files: {} };
    const put = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        source_hash: "hash-1",
        text_metrics_version: 1,
        scene,
        baseline: { elements: scene.elements },
      }),
    });
    assert.equal(put.status, 200);

    const loaded = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`).then((res) => res.json());
    assert.equal(loaded.whiteboard.source_hash, "hash-1");
    assert.equal(loaded.whiteboard.text_metrics_version, 1);
    assert.deepEqual(loaded.whiteboard.scene, { ...scene, appState: {} });
    assert.deepEqual(loaded.whiteboard.baseline, { elements: scene.elements });
  } finally {
    await ctx.close();
  }
});

test("whiteboard write routes reject cross-origin and unknown sessions", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const crossOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ source_hash: "x", scene: null }),
    });
    assert.equal(crossOrigin.status, 403);

    const noOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_hash: "x", scene: null }),
    });
    assert.equal(noOrigin.status, 403);

    const missingSession = await fetch(`${ctx.base}/api/ffffffffffffffff/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ source_hash: "x", scene: null }),
    });
    assert.equal(missingSession.status, 404);
  } finally {
    await ctx.close();
  }
});

test("whiteboard channel authentication accepts only the frame-issued token", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const frame = await fetch(`${ctx.base}/whiteboard-frame`).then((res) => res.text());
    const token = /__luxeWhiteboardChannelToken="([^"]+)"/.exec(frame)?.[1] || "";
    assert.ok(token);

    const accepted = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token }),
    });
    assert.equal(accepted.status, 200);

    const rejected = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token: "forged" }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await ctx.close();
  }
});

test("feedback-files writes the .excalidraw and PNG sidecars and returns their paths", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "B", type: "ellipse" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    assert.equal(response.status, 200);
    const { scene_path, preview_path } = await response.json();
    assert.ok(scene_path.endsWith(`${path.sep}whiteboards${path.sep}${ctx.key}${path.sep}1.excalidraw`));
    const sceneFile = JSON.parse(await readFile(scene_path, "utf8"));
    assert.equal(sceneFile.type, "excalidraw");
    assert.equal(sceneFile.elements[0].id, "B");
    const png = await readFile(preview_path);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await ctx.close();
  }
});

// The same-origin guard on this route is the only thing stopping a hostile page the user
// visits from writing arbitrary scene files and PNGs into the state directory through the
// loopback server. Upstream covered the whiteboard PUT but never this route.
test("feedback-files rejects cross-origin browser requests", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const payload = JSON.stringify({
      scene: { elements: [{ id: "X", type: "ellipse" }], appState: {}, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });

    const crossOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/feedback-files`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: payload,
    });
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: "cross-origin whiteboard write rejected" });

    const crossOriginReferer = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/feedback-files`, {
      method: "POST",
      headers: { "content-type": "application/json", referer: "https://evil.example/page" },
      body: payload,
    });
    assert.equal(crossOriginReferer.status, 403);

    const noProvenance = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/feedback-files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(noProvenance.status, 403);

    // The guard must run before anything is written: no sidecars for this session.
    await assert.rejects(readFile(path.join(ctx.dir, "whiteboards", ctx.key, "1.excalidraw"), "utf8"), /ENOENT/);
  } finally {
    await ctx.close();
  }
});

// The channel route is the whiteboard frame's authentication handshake. Without the
// same-origin guard a hostile page could probe it for a valid session key.
test("whiteboard-channel rejects cross-origin browser requests", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const frame = await fetch(`${ctx.base}/whiteboard-frame`).then((res) => res.text());
    const token = /__luxeWhiteboardChannelToken="([^"]+)"/.exec(frame)?.[1] || "";
    assert.ok(token, "frame issues a channel token");

    // A genuine token is not enough: the request must also be same-origin.
    const crossOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ token }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: "cross-origin whiteboard channel request rejected" });

    const crossOriginReferer = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: { "content-type": "application/json", referer: "https://evil.example/page" },
      body: JSON.stringify({ token }),
    });
    assert.equal(crossOriginReferer.status, 403);

    const noProvenance = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(noProvenance.status, 403);
  } finally {
    await ctx.close();
  }
});

test("whiteboard write routes accept payloads beyond the default 2mb JSON cap", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const bigText = "x".repeat(3 * 1024 * 1024);
    const bigScene = { elements: [{ id: "big", type: "text", text: bigText }], appState: {}, files: {} };

    const promptsResponse = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ prompts: [{ prompt: bigText, tag: "message" }] }),
    });
    assert.equal(promptsResponse.status, 413);

    const whiteboardResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ source_hash: "big", scene: bigScene }),
    });
    assert.equal(whiteboardResponse.status, 200);
  } finally {
    await ctx.close();
  }
});

test("whiteboard assets are served with Access-Control-Allow-Origin: * and traversal is blocked", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const bundle = await fetch(`${ctx.base}/whiteboard-assets/whiteboard.js`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get("access-control-allow-origin"), "*");

    const font = await fetch(`${ctx.base}/whiteboard-assets/fonts/Excalifont/Excalifont-Regular.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("access-control-allow-origin"), "*");

    const traversal = await fetch(`${ctx.base}/whiteboard-assets/..%2F..%2Fstate.json`);
    assert.equal(traversal.status, 403);

    const missing = await fetch(`${ctx.base}/whiteboard-assets/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    await ctx.close();
  }
});

test("the whiteboard frame page is served with the sandboxed chrome overlay pointing at it", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const framePage = await fetch(`${ctx.base}/whiteboard-frame`);
    assert.equal(framePage.status, 200);
    assert.equal(framePage.headers.get("cache-control"), "no-store");
    assert.match(await framePage.text(), /whiteboard-assets\/whiteboard\.js/);

    const chrome = await fetch(`${ctx.base}/session/${ctx.key}`).then((res) => res.text());
    assert.match(chrome, /id="whiteboardFrame"[^>]*sandbox="allow-scripts allow-popups"/);
    assert.doesNotMatch(chrome, /whiteboardFrame[^>]*allow-same-origin/);
    // The artifact iframe's sandbox must be unchanged by this feature.
    assert.match(chrome, /id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads"/);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Ephemeral whiteboards over HTTP (D5). The save protocol above is unchanged;
// these cover the explicit keep and the three cleanup exits end to end.
// ---------------------------------------------------------------------------

async function saveScene(ctx, index, body = {}) {
  const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/${index}`, {
    method: "PUT",
    headers: ctx.sameOrigin,
    body: JSON.stringify({
      source_hash: "hash",
      text_metrics_version: 2,
      scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
      baseline: { elements: [{ id: "A", type: "rectangle" }] },
      ...body,
    }),
  });
  assert.equal(response.status, 200);
}

test("POST save-to-machine writes both files next to the artifact and returns their paths", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await saveScene(ctx, 0);

    const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    // F1: next to the artifact, keyed by the document-order Mermaid index.
    assert.equal(body.scene_path, path.join(ctx.realDir, "artifact.wb0.excalidraw"));
    assert.equal(body.preview_path, path.join(ctx.realDir, "artifact.wb0.png"));
    assert.equal(JSON.parse(await readFile(body.scene_path, "utf8")).type, "excalidraw");
    assert.ok((await readFile(body.preview_path)).length > 0);
  } finally {
    await ctx.close();
  }
});

// The destination comes from the session's own artifact path. A caller picks
// which diagram to keep, never where it lands.
test("save-to-machine ignores any caller-supplied destination", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await saveScene(ctx, 0);

    const body = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
        artifactFile: "/etc/passwd",
        scenePath: "/tmp/anywhere.excalidraw",
        artifact_file: path.join(ctx.dir, "..", "escape.html"),
      }),
    }).then((res) => res.json());

    assert.equal(body.scene_path, path.join(ctx.realDir, "artifact.wb0.excalidraw"));
  } finally {
    await ctx.close();
  }
});

test("save-to-machine is same-origin guarded and index-checked like the other writes", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await saveScene(ctx, 0);
    const payload = JSON.stringify({ scene: { elements: [] }, pngDataUrl: "" });

    const crossOrigin = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/save-to-machine`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: payload,
    });
    assert.equal(crossOrigin.status, 403);

    const badIndex = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/9999/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: payload,
    });
    assert.equal(badIndex.status, 404);

    const badKey = await fetch(`${ctx.base}/api/0000000000000000/whiteboard/0/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: payload,
    });
    assert.equal(badKey.status, 404);
  } finally {
    await ctx.close();
  }
});

// The overlay checks the index against the extracted Mermaid sources before it
// opens, but that check is client-side. Without the same check here, any
// same-origin caller could keep a diagram the artifact does not have: `0x10`
// wrote `artifact.wb16.excalidraw`, `007` wrote `wb7` and `999` wrote `wb999`,
// all with status 200, on an artifact whose only diagrams are 0 and 1.
test("save-to-machine refuses an index the artifact's own Mermaid sources do not have", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const payload = JSON.stringify({ scene: { elements: [] }, pngDataUrl: "" });
    for (const index of ["0x10", "007", "999", "2", "0.0", " 0"]) {
      const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/${index}/save-to-machine`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: payload,
      });
      assert.equal(response.status, 404, `index ${index} must not name a diagram`);
    }
    const written = (await readdir(ctx.realDir)).filter((entry) => entry.includes(".wb"));
    assert.deepEqual(written, [], "a rejected index must not write anything next to the artifact");

    // And the two diagrams the artifact really has are still keepable.
    const ok = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: payload,
    });
    assert.equal(ok.status, 200);
  } finally {
    await ctx.close();
  }
});

// Ending a session is what makes its whiteboards collectable. A save landing
// after the end recreated the swept sidecar directory holding nothing but an
// orphan retain marker, which no later cleanup pass would ever remove.
test("save-to-machine is refused once the session has ended", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await saveScene(ctx, 0);
    // A second session keeps the server up: ending the last one shuts it down.
    const other = path.join(ctx.dir, "other.html");
    await writeFile(other, ARTIFACT_HTML);
    await fetch(`${ctx.base}/api/sessions`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ file: other }),
    });
    await fetch(`${ctx.base}/api/${ctx.key}/end`, { method: "POST", headers: ctx.sameOrigin, body: "{}" });

    const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ scene: { elements: [] }, pngDataUrl: "" }),
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /ended/);
    const written = (await readdir(ctx.realDir)).filter((entry) => entry.includes(".wb"));
    assert.deepEqual(written, [], "an ended session must not write kept copies");
    // And the swept sidecar directory was not recreated behind the sweep.
    assert.equal(
      await readdir(path.join(ctx.dir, "whiteboards", ctx.key)).then(
        () => "present",
        () => "gone",
      ),
      "gone",
    );
  } finally {
    await ctx.close();
  }
});

test("F3 exit 1: ending a session sweeps its scenes but spares the kept one", async () => {
  const ctx = await startWhiteboardServer();
  try {
    await saveScene(ctx, 0);
    await saveScene(ctx, 1);
    await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/save-to-machine`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ scene: { elements: [] }, pngDataUrl: PNG_DATA_URL }),
    });

    // Ending the last open session also stops the server, so read the sidecars
    // from disk rather than back through a socket that is on its way down.
    await fetch(`${ctx.base}/api/${ctx.key}/end`, { method: "POST", headers: ctx.sameOrigin, body: "{}" });
    await ctx.server.done;

    const { loadWhiteboard } = await import("../src/whiteboard-store.js");
    assert.equal(await loadWhiteboard(ctx.dir, ctx.key, 0), null);
    assert.ok(await loadWhiteboard(ctx.dir, ctx.key, 1), "a retained scene must survive session end");
    // And the copies next to the artifact are untouched either way.
    assert.ok(await readFile(path.join(ctx.realDir, "artifact.wb1.excalidraw"), "utf8"));
  } finally {
    await ctx.close();
  }
});

test("F3 exit 3: a new server sweeps the sidecars of sessions that already ended", async () => {
  const ctx = await startWhiteboardServer();
  const stateFile = path.join(ctx.dir, "state.json");
  try {
    await saveScene(ctx, 0);
    // End the session, but write the sidecar back afterwards so this test
    // exercises the STARTUP sweep rather than the end-of-session one - which is
    // exactly the state a crash or an idle-shutdown skip leaves behind.
    await fetch(`${ctx.base}/api/${ctx.key}/end`, { method: "POST", headers: ctx.sameOrigin, body: "{}" });
    await ctx.server.done;
    const { saveWhiteboard } = await import("../src/whiteboard-store.js");
    await saveWhiteboard(ctx.dir, ctx.key, 0, {
      sourceHash: "hash",
      textMetricsVersion: 2,
      scene: { elements: [], appState: {}, files: {} },
      baseline: { elements: [] },
    });

    const restarted = await serve({ port: 0, stateFile });
    try {
      const after = await fetch(`http://127.0.0.1:${restarted.port}/api/${ctx.key}/whiteboard/0`).then((res) =>
        res.json(),
      );
      assert.equal(after.whiteboard, null);
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("F3 exit 3: the startup sweep leaves a still-open session's scenes alone", async () => {
  const ctx = await startWhiteboardServer();
  const stateFile = path.join(ctx.dir, "state.json");
  try {
    await saveScene(ctx, 0);
    await ctx.server.close();

    const restarted = await serve({ port: 0, stateFile });
    try {
      const after = await fetch(`http://127.0.0.1:${restarted.port}/api/${ctx.key}/whiteboard/0`).then((res) =>
        res.json(),
      );
      assert.ok(after.whiteboard, "an open session's working scene must survive a server restart");
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

// Exit 2. The timer is set to a millisecond so the shutdown path runs for real.
test("F3 exit 2: idle shutdown sweeps an unedited scene", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-wb-idle-"));
  try {
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, ARTIFACT_HTML);
    const stateFile = path.join(dir, "state.json");
    const server = await serve({ port: 0, stateFile, idleTimeoutMs: 20 });
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
    await saveScene({ base, key: opened.key, sameOrigin: { "content-type": "application/json", origin: base } }, 0);

    await server.done;

    const { loadWhiteboard } = await import("../src/whiteboard-store.js");
    assert.equal(await loadWhiteboard(dir, opened.key, 0), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// D5's "one sharp edge", blunted: walking away from work in progress must not
// destroy it. The startup sweep collects it later, once the session is over.
test("F3 exit 2: idle shutdown leaves a scene with unsaved edits in place", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-wb-idle-dirty-"));
  try {
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, ARTIFACT_HTML);
    const stateFile = path.join(dir, "state.json");
    const server = await serve({ port: 0, stateFile, idleTimeoutMs: 20 });
    const base = `http://127.0.0.1:${server.port}`;
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
    const ctx = { base, key: opened.key, sameOrigin: { "content-type": "application/json", origin: base } };
    await saveScene(ctx, 0, {
      scene: {
        elements: [
          { id: "A", type: "rectangle" },
          { id: "B", type: "freedraw", x: 5, y: 5 },
        ],
        appState: {},
        files: {},
      },
      baseline: { elements: [{ id: "A", type: "rectangle" }] },
    });

    await server.done;

    const { loadWhiteboard } = await import("../src/whiteboard-store.js");
    assert.ok(await loadWhiteboard(dir, opened.key, 0), "in-progress edits must survive an idle shutdown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
