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
const MIB = 1024 * 1024;

function sceneWithSerializedBytes(byteLength) {
  const base = { elements: [], appState: {}, files: {}, padding: "" };
  const fixedBytes = Buffer.byteLength(JSON.stringify(base));
  return { ...base, padding: "x".repeat(byteLength - fixedBytes) };
}

function pngDataUrlOfDecodedBytes(byteLength) {
  return `data:image/png;base64,${Buffer.alloc(byteLength).toString("base64")}`;
}

function whiteboardPromptTarget(scenePath, previewPath, diagramIndex = 0) {
  return {
    type: "excalidraw-scene",
    diagramIndex,
    diagramId: `mermaid-${diagramIndex + 1}`,
    sourceHash: "source-hash",
    scenePath,
    previewPath,
    imageFallback: false,
    stats: { added: 1, removed: 0, moved: 0, relabeled: 0, drawn: 0 },
  };
}

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
    assetsDir,
    // The session store canonicalizes the artifact path, and on macOS the temp
    // dir is a symlink, so kept files land under the resolved path.
    realDir: await realpath(dir),
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

function pollOnce(ctx, timeoutMs = 0) {
  return fetch(`${ctx.base}/api/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: ctx.artifact, timeoutMs }),
  }).then((response) => response.json());
}

test("isWhiteboardWriteApiPath matches only whiteboard write routes", () => {
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0", "PUT"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/12/feedback-files", "POST"), true);
  // The kept-copy route carries a full-resolution PNG data URL, so it needs the
  // 20 MB body limit exactly like the other whiteboard writes.
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/3/save-to-machine", "POST"), true);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0", "POST"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0", "GET"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/3/feedback-files", "PUT"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/3/save-to-machine", "GET"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/3/save-to-elsewhere", "POST"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/prompts", "POST"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/9999", "PUT"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/BAD/whiteboard/0", "PUT"), false);
  // The index pattern is the canonical decimal form the routes accept, so no
  // path the routes will reject can claim the 20 MB body cap.
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/007", "PUT"), false);
  assert.equal(isWhiteboardWriteApiPath("/api/0123456789abcdef/whiteboard/0x10", "PUT"), false);
  assert.equal(isWhiteboardWriteApiPath("/whiteboard-frame", "GET"), false);
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

test("prompt batches reject only whiteboard targets outside the current session", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const filesResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/1/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "B", type: "ellipse" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    const { scene_path: scenePath, preview_path: previewPath } = await filesResponse.json();
    const validTarget = {
      type: "excalidraw-scene",
      diagramIndex: 1,
      diagramId: "mermaid-2",
      sourceHash: "source-hash",
      scenePath,
      previewPath,
      imageFallback: false,
      stats: { added: 1, removed: 0, moved: 0, relabeled: 0, drawn: 0 },
    };
    const hostileTarget = { ...validTarget, scenePath: "/etc/passwd", previewPath: "" };

    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        endSession: true,
        prompts: [
          { prompt: "Keep the human message", tag: "message", text: "Freeform message" },
          { prompt: "Read this file", tag: "whiteboard", target: hostileTarget },
          { prompt: "Apply the diagram edit", tag: "whiteboard", target: validTarget },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "partial",
      pending_prompts: 2,
      accepted_prompt_indices: [0, 2],
      rejected_prompts: [{ index: 1, code: "invalid_whiteboard_target" }],
      session_ended: false,
    });

    const feedback = await pollOnce(ctx);
    assert.deepEqual(
      feedback.prompts.map((prompt) => prompt.prompt),
      ["Keep the human message", "Apply the diagram edit"],
    );
    assert.equal(
      feedback.prompts.some((prompt) => prompt.target?.scenePath === "/etc/passwd"),
      false,
    );
    assert.equal(feedback.session_ended, undefined);
    assert.deepEqual(await pollOnce(ctx), { status: "waiting" });
  } finally {
    await ctx.close();
  }
});

test("default prompt routes reject oversized top-level context without mutating the queue", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const oversizedSnapshot = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        domSnapshot: "x".repeat(300 * 1024),
        prompts: [{ prompt: "Must remain unsent", text: "Heading", selector: "h1", tag: "annotation" }],
      }),
    });
    assert.equal(oversizedSnapshot.status, 413);
    assert.equal((await pollOnce(ctx)).status, "waiting");

    const oversizedBatch = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: Array.from({ length: 101 }, (_, index) => ({
          prompt: `Prompt ${index}`,
          text: "",
          selector: "",
          tag: "message",
        })),
      }),
    });
    assert.equal(oversizedBatch.status, 413);
    assert.equal((await pollOnce(ctx)).status, "waiting");
  } finally {
    await ctx.close();
  }
});

test("a 1.5-million-character prompt is rejected locally while valid batch neighbors deliver", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: [
          { prompt: "Valid human message", text: "Freeform message", selector: "", tag: "message" },
          { prompt: "x".repeat(1_500_000), text: "", selector: "", tag: "message" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "partial",
      pending_prompts: 1,
      accepted_prompt_indices: [0],
      rejected_prompts: [{ index: 1, code: "prompt_too_large" }],
      session_ended: false,
    });
    const feedback = await pollOnce(ctx);
    assert.deepEqual(
      feedback.prompts.map((prompt) => prompt.prompt),
      ["Valid human message"],
    );
  } finally {
    await ctx.close();
  }
});

test("prompt and context limits count UTF-8 bytes rather than JavaScript characters", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const exactPrompt = "é".repeat((16 * 1024) / 2);
    const oversizedPrompt = `${exactPrompt}é`;
    const exactContext = "é".repeat((4 * 1024) / 2);
    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: [
          { prompt: exactPrompt, text: exactContext, selector: "", tag: "message" },
          { prompt: oversizedPrompt, text: "", selector: "", tag: "message" },
          { prompt: "Oversized context", text: `${exactContext}é`, selector: "", tag: "message" },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).rejected_prompts, [
      { index: 1, code: "prompt_too_large" },
      { index: 2, code: "prompt_too_large" },
    ]);
    const feedback = await pollOnce(ctx);
    assert.equal(Buffer.byteLength(feedback.prompts[0].prompt, "utf8"), 16 * 1024);
    assert.equal(Buffer.byteLength(feedback.prompts[0].text, "utf8"), 4 * 1024);
  } finally {
    await ctx.close();
  }
});

test("prompt targets are a bounded closed union with exact-limit positive controls", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const validPrompt = {
      prompt: "p".repeat(16 * 1024),
      text: "t".repeat(4 * 1024),
      selector: "s".repeat(512),
      tag: "message",
      target: {
        type: "text-range",
        text: "t".repeat(4 * 1024),
        selector: "s".repeat(512),
        start: {
          selector: "s".repeat(512),
          path: Array.from({ length: 64 }, (_, index) => index),
          offset: Number.MAX_SAFE_INTEGER,
        },
        end: { selector: "s".repeat(512), path: [], offset: 0 },
      },
    };
    const invalidTargets = [
      { type: "unknown", payload: "hidden" },
      {
        type: "mermaid-node",
        diagramId: "flow",
        nodeId: "A",
        label: "A",
        selector: "svg#flow > g#A",
        hidden: "not allowed",
      },
      {
        type: "text-range",
        text: "Selected",
        selector: "p",
        start: { selector: "p", path: Array.from({ length: 65 }, () => 0), offset: 0 },
        end: { selector: "p", path: [], offset: 0 },
      },
      {
        type: "text-range",
        text: "Selected",
        selector: "p",
        start: { selector: "p", path: [0], offset: -1 },
        end: { selector: "p", path: [], offset: 0 },
      },
    ];
    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: [
          validPrompt,
          ...invalidTargets.map((target, index) => ({
            prompt: `Invalid ${index}`,
            text: "",
            selector: "",
            tag: "annotation",
            target,
          })),
        ],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.accepted_prompt_indices, [0]);
    assert.deepEqual(body.rejected_prompts, [
      { index: 1, code: "invalid_prompt" },
      { index: 2, code: "invalid_prompt" },
      { index: 3, code: "prompt_too_large" },
      { index: 4, code: "invalid_prompt" },
    ]);
    const feedback = await pollOnce(ctx);
    assert.equal(feedback.prompts[0].prompt.length, 16 * 1024);
    assert.equal(feedback.prompts[0].text.length, 4 * 1024);
    assert.equal(feedback.prompts[0].selector.length, 512);
  } finally {
    await ctx.close();
  }
});

test("default-route exact batch and snapshot limits remain accepted", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const prompts = Array.from({ length: 100 }, (_, index) => ({
      prompt: `Prompt ${index}`,
      text: "",
      selector: "",
      tag: "message",
    }));
    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ prompts, domSnapshot: "x".repeat(128 * 1024) }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accepted_prompt_indices.length, 100);
    const feedback = await pollOnce(ctx);
    assert.equal(feedback.prompts.length, 100);
    assert.equal(Buffer.byteLength(feedback.dom_snapshot), 128 * 1024);
  } finally {
    await ctx.close();
  }
});

test("default-route context paths, reply text, and channel identifiers are bounded", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const oversizedPath = "x".repeat(4 * 1024 + 1);
    /** @type {Array<[string, Record<string, unknown>]>} */
    const boundedPathRequests = [
      ["/api/sessions", { file: oversizedPath }],
      ["/api/poll", { file: oversizedPath, timeoutMs: 0 }],
      ["/api/end", { file: oversizedPath }],
    ];
    for (const [pathname, body] of boundedPathRequests) {
      const response = await fetch(`${ctx.base}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 413, pathname);
    }

    const exactReply = await fetch(`${ctx.base}/api/${ctx.key}/agent-reply`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ text: "x".repeat(4 * 1024) }),
    });
    assert.equal(exactReply.status, 200);
    const oversizedReply = await fetch(`${ctx.base}/api/${ctx.key}/agent-reply`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ text: "x".repeat(4 * 1024 + 1) }),
    });
    assert.equal(oversizedReply.status, 413);

    const channel = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token: "x".repeat(513) }),
    });
    assert.equal(channel.status, 413);
  } finally {
    await ctx.close();
  }
});

test("an all-rejected whiteboard batch does not wake polling", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: [
          {
            prompt: "Read a caller path",
            tag: "whiteboard",
            target: {
              type: "excalidraw-scene",
              diagramIndex: 1,
              scenePath: "/etc/passwd",
              previewPath: "",
            },
          },
          {
            prompt: "Use an aliased whiteboard type",
            tag: "whiteboard",
            target: {
              type: "excalidraw_scene",
              diagramIndex: 1,
              scenePath: "/etc/passwd",
              previewPath: "",
            },
          },
          {
            prompt: "Hide a path on a text range",
            tag: "annotation",
            target: {
              type: "text-range",
              text: "x",
              selector: "p",
              start: { selector: "p", path: [0], offset: 0 },
              end: { selector: "p", path: [0], offset: 1 },
              scene_path: "/etc/passwd",
            },
          },
        ],
      }),
    });

    assert.deepEqual(await response.json(), {
      status: "rejected",
      pending_prompts: 0,
      accepted_prompt_indices: [],
      rejected_prompts: [
        { index: 0, code: "invalid_whiteboard_target" },
        { index: 1, code: "invalid_whiteboard_target" },
        { index: 2, code: "invalid_whiteboard_target" },
      ],
      session_ended: false,
    });
    assert.deepEqual(await pollOnce(ctx), { status: "waiting" });
  } finally {
    await ctx.close();
  }
});

test("all-valid whiteboard send-and-end keeps feedback files readable for polling", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const filesResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    const { scene_path: scenePath, preview_path: previewPath } = await filesResponse.json();
    const pollPromise = pollOnce(ctx, 5000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        endSession: true,
        prompts: [
          {
            prompt: "Apply the whiteboard edit",
            tag: "whiteboard",
            target: {
              type: "excalidraw-scene",
              diagramIndex: 0,
              diagramId: "mermaid-1",
              sourceHash: "source-hash",
              scenePath,
              previewPath,
              imageFallback: false,
              stats: { added: 1, removed: 0, moved: 0, relabeled: 0, drawn: 0 },
            },
          },
        ],
      }),
    });
    const result = await response.json();

    assert.equal(result.session_ended, true);
    assert.equal(JSON.parse(await readFile(scenePath, "utf8")).type, "excalidraw");
    const feedback = await pollPromise;
    assert.equal(feedback.session_ended, true);
    assert.equal(feedback.prompts[0].target.scenePath, scenePath);
    assert.equal(JSON.parse(await readFile(feedback.prompts[0].target.scenePath, "utf8")).type, "excalidraw");
  } finally {
    await ctx.close();
  }
});

test("queued ended-session whiteboard feedback survives server restart until polling", async () => {
  const ctx = await startWhiteboardServer();
  let restarted;
  try {
    const filesResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    const { scene_path: scenePath, preview_path: previewPath } = await filesResponse.json();
    await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        endSession: true,
        prompts: [
          {
            prompt: "Apply the queued edit",
            tag: "whiteboard",
            target: whiteboardPromptTarget(scenePath, previewPath),
          },
        ],
      }),
    });
    await ctx.server.done;
    assert.equal(JSON.parse(await readFile(scenePath, "utf8")).type, "excalidraw");

    restarted = await serve({
      port: 0,
      stateFile: path.join(ctx.dir, "state.json"),
      version: "9.9.9-test",
      whiteboardAssetsDir: ctx.assetsDir,
    });
    const restartedBase = `http://127.0.0.1:${restarted.port}`;
    const feedback = await fetch(`${restartedBase}/api/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: ctx.artifact, timeoutMs: 0 }),
    }).then((response) => response.json());

    assert.equal(feedback.prompts[0].target.scenePath, scenePath);
    assert.equal(JSON.parse(await readFile(scenePath, "utf8")).type, "excalidraw");
  } finally {
    await restarted?.close();
    await ctx.close();
  }
});

test("ending with a later message preserves an earlier queued whiteboard target", async () => {
  const ctx = await startWhiteboardServer();
  let restarted;
  try {
    const filesResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    const { scene_path: scenePath, preview_path: previewPath } = await filesResponse.json();
    await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        prompts: [
          {
            prompt: "Apply the earlier whiteboard edit",
            tag: "whiteboard",
            target: whiteboardPromptTarget(scenePath, previewPath),
          },
        ],
      }),
    });
    const ending = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        endSession: true,
        prompts: [{ prompt: "A later human message", tag: "message", text: "Freeform message" }],
      }),
    }).then((response) => response.json());

    assert.equal(ending.session_ended, true);
    assert.equal(JSON.parse(await readFile(scenePath, "utf8")).type, "excalidraw");
    await ctx.server.done;
    restarted = await serve({
      port: 0,
      stateFile: path.join(ctx.dir, "state.json"),
      version: "9.9.9-test",
      whiteboardAssetsDir: ctx.assetsDir,
    });
    const feedback = await fetch(`http://127.0.0.1:${restarted.port}/api/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: ctx.artifact, timeoutMs: 0 }),
    }).then((response) => response.json());
    assert.deepEqual(
      feedback.prompts.map((prompt) => prompt.prompt),
      ["Apply the earlier whiteboard edit", "A later human message"],
    );
    assert.equal(JSON.parse(await readFile(feedback.prompts[0].target.scenePath, "utf8")).type, "excalidraw");
  } finally {
    await restarted?.close();
    await ctx.close();
  }
});

test("an all-rejected repeat cannot delete already-queued ended whiteboard feedback", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const filesResponse = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
        pngDataUrl: PNG_DATA_URL,
      }),
    });
    const { scene_path: scenePath, preview_path: previewPath } = await filesResponse.json();
    const otherArtifact = path.join(ctx.dir, "other.html");
    await writeFile(otherArtifact, "<!doctype html><html><body>Other session</body></html>");
    await fetch(`${ctx.base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: otherArtifact }),
    });
    await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        endSession: true,
        prompts: [
          {
            prompt: "Apply the queued edit",
            tag: "whiteboard",
            target: whiteboardPromptTarget(scenePath, previewPath),
          },
        ],
      }),
    });

    const repeated = await fetch(`${ctx.base}/api/${ctx.key}/prompts`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        endSession: true,
        prompts: [
          {
            prompt: "Hostile repeat",
            tag: "whiteboard",
            target: { type: "excalidraw-scene", diagramIndex: 0, scenePath: "/etc/passwd" },
          },
        ],
      }),
    }).then((response) => response.json());

    assert.equal(repeated.status, "rejected");
    assert.equal(JSON.parse(await readFile(scenePath, "utf8")).type, "excalidraw");
    const feedback = await pollOnce(ctx);
    assert.equal(feedback.prompts[0].target.scenePath, scenePath);
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

test("wrong-method whiteboard paths remain under the default 2mb parser", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ padding: "x".repeat(3 * MIB) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await ctx.close();
  }
});

test("all three 20mb routes enforce the 8 MiB scene boundary", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const oversizedScene = sceneWithSerializedBytes(8 * MIB + 1);
    const requests = [
      fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
        method: "PUT",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ source_hash: "hash", text_metrics_version: 0, scene: oversizedScene, baseline: null }),
      }),
      fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ scene: oversizedScene, pngDataUrl: "" }),
      }),
      fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/save-to-machine`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ scene: oversizedScene, pngDataUrl: "" }),
      }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(
      responses.map((response) => response.status),
      [413, 413, 413],
    );
  } finally {
    await ctx.close();
  }
});

test("whiteboard baseline and PNG caps apply beneath the 20mb parser", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const oversizedBaseline = sceneWithSerializedBytes(8 * MIB + 1);
    const baseline = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        source_hash: "hash",
        text_metrics_version: 0,
        scene: { elements: [], appState: {}, files: {} },
        baseline: oversizedBaseline,
      }),
    });
    assert.equal(baseline.status, 413);

    const oversizedPng = pngDataUrlOfDecodedBytes(8 * MIB + 1);
    for (const suffix of ["feedback-files", "save-to-machine"]) {
      const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/${suffix}`, {
        method: "POST",
        headers: ctx.sameOrigin,
        body: JSON.stringify({ scene: { elements: [], appState: {}, files: {} }, pngDataUrl: oversizedPng }),
      });
      assert.equal(response.status, 413, suffix);
    }
  } finally {
    await ctx.close();
  }
});

test("whiteboard count, hash, metrics, and PNG shape limits reject without truncation", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const tooManyElements = Array.from({ length: 10_001 }, (_, index) => ({ id: String(index) }));
    const tooManyFiles = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [String(index), { id: String(index) }]),
    );
    const cases = [
      {
        body: { source_hash: "x", scene: { elements: tooManyElements, files: {} } },
        status: 413,
      },
      {
        body: { source_hash: "x", scene: { elements: [], files: tooManyFiles } },
        status: 413,
      },
      {
        body: { source_hash: "x".repeat(257), scene: { elements: [], files: {} } },
        status: 413,
      },
      {
        body: { source_hash: "x", text_metrics_version: -1, scene: { elements: [], files: {} } },
        status: 400,
      },
    ];
    for (const item of cases) {
      const response = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
        method: "PUT",
        headers: ctx.sameOrigin,
        body: JSON.stringify(item.body),
      });
      assert.equal(response.status, item.status);
    }

    const malformedPng = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ scene: { elements: [], files: {} }, pngDataUrl: "data:image/png;base64,***" }),
    });
    assert.equal(malformedPng.status, 400);
  } finally {
    await ctx.close();
  }
});

test("whiteboard exact limits remain accepted", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const exactScene = sceneWithSerializedBytes(8 * MIB);
    const put = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0`, {
      method: "PUT",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        source_hash: "x".repeat(256),
        text_metrics_version: Number.MAX_SAFE_INTEGER,
        scene: exactScene,
        baseline: { elements: Array.from({ length: 10_000 }, () => ({})) },
      }),
    });
    assert.equal(put.status, 200);

    const feedback = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard/0/feedback-files`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({
        scene: { elements: [], files: Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [i, {}])) },
        pngDataUrl: pngDataUrlOfDecodedBytes(8 * MIB),
      }),
    });
    assert.equal(feedback.status, 200);
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

async function seedIdleShutdownScene(dir, body = {}) {
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, ARTIFACT_HTML);
  const stateFile = path.join(dir, "state.json");
  const seedServer = await serve({ port: 0, stateFile, idleTimeoutMs: null });
  const base = `http://127.0.0.1:${seedServer.port}`;
  try {
    const opened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
    await saveScene(
      { base, key: opened.key, sameOrigin: { "content-type": "application/json", origin: base } },
      0,
      body,
    );
    return { key: opened.key, stateFile };
  } finally {
    await seedServer.close();
  }
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
    const { key, stateFile } = await seedIdleShutdownScene(dir);
    const server = await serve({ port: 0, stateFile, idleTimeoutMs: 20 });

    await server.done;

    const { loadWhiteboard } = await import("../src/whiteboard-store.js");
    assert.equal(await loadWhiteboard(dir, key, 0), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// D5's "one sharp edge", blunted: walking away from work in progress must not
// destroy it. The startup sweep collects it later, once the session is over.
test("F3 exit 2: idle shutdown leaves a scene with unsaved edits in place", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-wb-idle-dirty-"));
  try {
    const { key, stateFile } = await seedIdleShutdownScene(dir, {
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
    const server = await serve({ port: 0, stateFile, idleTimeoutMs: 20 });

    await server.done;

    const { loadWhiteboard } = await import("../src/whiteboard-store.js");
    assert.ok(await loadWhiteboard(dir, key, 0), "in-progress edits must survive an idle shutdown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
