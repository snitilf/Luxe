import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactWhiteboardBasename,
  cleanupSessionWhiteboards,
  decodePngDataUrl,
  isValidDiagramIndex,
  isValidWhiteboardKey,
  isWhiteboardRetained,
  listSessionWhiteboards,
  loadWhiteboard,
  saveWhiteboard,
  savedWhiteboardPaths,
  saveWhiteboardToMachine,
  sessionHasUnsavedWhiteboardEdits,
  sweepOrphanWhiteboards,
  whiteboardDir,
  whiteboardFeedbackPaths,
  writeWhiteboardFeedbackFiles,
} from "../src/whiteboard-store.js";

const KEY = "0123456789abcdef";
// A 1x1 transparent PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "luxe-whiteboard-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("saveWhiteboard/loadWhiteboard strips persisted theme and canvas background", async () => {
  await withTempDir(async (dir) => {
    const scene = {
      elements: [{ id: "A", type: "rectangle" }],
      appState: { theme: "dark", viewBackgroundColor: "#121212", scrollX: 12 },
      files: {},
    };
    const baseline = { elements: [{ id: "A", type: "rectangle" }] };
    await saveWhiteboard(dir, KEY, 0, { sourceHash: "hash-1", textMetricsVersion: 1, scene, baseline });
    const loaded = await loadWhiteboard(dir, KEY, 0);
    assert.equal(loaded.source_hash, "hash-1");
    assert.equal(loaded.text_metrics_version, 1);
    assert.deepEqual(loaded.scene, {
      ...scene,
      appState: { scrollX: 12 },
    });
    assert.deepEqual(loaded.baseline, baseline);
    assert.ok(loaded.updated_at);
  });
});

test("loadWhiteboard returns null when nothing was saved", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await loadWhiteboard(dir, KEY, 3), null);
  });
});

test("saveWhiteboard overwrites prior state for the same diagram", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h1", scene: { elements: [] }, baseline: null });
    await saveWhiteboard(dir, KEY, 1, { sourceHash: "h2", scene: { elements: [{ id: "B" }] }, baseline: null });
    const loaded = await loadWhiteboard(dir, KEY, 1);
    assert.equal(loaded.source_hash, "h2");
    assert.equal(loaded.scene.elements.length, 1);
  });
});

test("concurrent saves preserve the most recent scene", async () => {
  await withTempDir(async (dir) => {
    const slowScene = { elements: [{ id: "old", text: "x".repeat(8 * 1024 * 1024) }] };
    const latestScene = { elements: [{ id: "latest" }] };
    await Promise.all([
      saveWhiteboard(dir, KEY, 5, { sourceHash: "old", scene: slowScene, baseline: null }),
      saveWhiteboard(dir, KEY, 5, { sourceHash: "latest", scene: latestScene, baseline: null }),
    ]);
    const loaded = await loadWhiteboard(dir, KEY, 5);
    assert.equal(loaded.source_hash, "latest");
    assert.deepEqual(loaded.scene, latestScene);
  });
});

test("store rejects invalid keys and indexes (path traversal guard)", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() => saveWhiteboard(dir, "../../etc", 0, { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => saveWhiteboard(dir, KEY, "../7", { sourceHash: "", scene: null }), /invalid/);
    await assert.rejects(() => loadWhiteboard(dir, "ZZZZ", 0), /invalid/);
    await assert.rejects(() => writeWhiteboardFeedbackFiles(dir, KEY, -1, { scene: null }), /invalid/);
  });
});

test("isValidWhiteboardKey / isValidDiagramIndex validate shapes", () => {
  assert.equal(isValidWhiteboardKey(KEY), true);
  assert.equal(isValidWhiteboardKey("0123"), false);
  assert.equal(isValidWhiteboardKey("0123456789ABCDEF"), false);
  assert.equal(isValidDiagramIndex(0), true);
  assert.equal(isValidDiagramIndex("12"), true);
  assert.equal(isValidDiagramIndex(1000), false);
  assert.equal(isValidDiagramIndex(-1), false);
  assert.equal(isValidDiagramIndex(1.5), false);
});

// The validator used to be `Number(index)`, which meant every value JavaScript
// coerces to a small integer named a diagram: a route param of `0x10` reached
// the store as 16, and `null`, `""` and `[]` all reached it as 0. Route params
// are strings from the network, so this is the difference between "the caller
// named a diagram" and "the caller sent junk and got diagram 0".
test("isValidDiagramIndex refuses everything that merely coerces to an index", () => {
  for (const value of [null, undefined, "", " ", [], [0], {}, true, false, NaN, Infinity])
    assert.equal(isValidDiagramIndex(/** @type {any} */ (value)), false, `${String(value)} must not be an index`);
  // Non-canonical decimal strings, which are what the probes used.
  for (const value of ["0x10", "007", "1e2", " 1", "1 ", "+1", "1.0", "-0", "1_0"])
    assert.equal(isValidDiagramIndex(value), false, `${value} must not be an index`);
  // And the canonical forms still are.
  for (const value of ["0", "7", "999", 0, 7, 999]) assert.equal(isValidDiagramIndex(value), true);
});

test("writeWhiteboardFeedbackFiles writes a standalone .excalidraw and a PNG", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 2, {
      scene: { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "light" }, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });
    assert.deepEqual({ scenePath, previewPath }, whiteboardFeedbackPaths(dir, KEY, 2));
    const scene = JSON.parse(await readFile(scenePath, "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.equal(scene.version, 2);
    assert.equal(scene.source, "luxe");
    assert.equal(scene.elements[0].id, "A");
    assert.deepEqual(scene.appState, {});
    const png = await readFile(previewPath);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

test("writeWhiteboardFeedbackFiles tolerates a missing or invalid preview", async () => {
  await withTempDir(async (dir) => {
    const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(dir, KEY, 4, {
      scene: { elements: [] },
      pngDataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    });
    assert.ok(scenePath.endsWith("4.excalidraw"));
    assert.equal(previewPath, "");
  });
});

test("decodePngDataUrl only accepts base64 PNG data URLs", () => {
  assert.ok(decodePngDataUrl(PNG_DATA_URL) instanceof Buffer);
  assert.equal(decodePngDataUrl("data:image/jpeg;base64,abcd"), null);
  assert.equal(decodePngDataUrl("not-a-data-url"), null);
  assert.equal(decodePngDataUrl(null), null);
});

// ---------------------------------------------------------------------------
// Ephemeral whiteboards (D5, F1/F2/F3). The save protocol above is unchanged;
// everything below is about what survives the end of a session.
// ---------------------------------------------------------------------------

const OTHER_KEY = "fedcba9876543210";

async function seedScene(dir, key, index, { elements = [{ id: "A", type: "rectangle" }], baseline = null } = {}) {
  await saveWhiteboard(dir, key, index, {
    sourceHash: "hash",
    textMetricsVersion: 2,
    scene: { elements, appState: {}, files: {} },
    baseline: baseline ?? { elements },
  });
}

test("F1: a kept whiteboard lands next to the artifact under the diagram index", () => {
  assert.equal(artifactWhiteboardBasename("/p/report.html"), "report");
  assert.equal(artifactWhiteboardBasename("/p/multi.part.html"), "multi.part");
  assert.deepEqual(savedWhiteboardPaths("/p/report.html", 2), {
    scenePath: path.join("/p", "report.wb2.excalidraw"),
    previewPath: path.join("/p", "report.wb2.png"),
  });
});

test("F2: save to machine writes both the scene and the PNG, and marks the sidecar retained", async () => {
  await withTempDir(async (dir) => {
    const artifact = path.join(dir, "report.html");
    await seedScene(dir, KEY, 0);

    const result = await saveWhiteboardToMachine(dir, KEY, 0, {
      artifactFile: artifact,
      scene: { elements: [{ id: "A", type: "rectangle" }], appState: { theme: "dark" }, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });

    assert.equal(result.scenePath, path.join(dir, "report.wb0.excalidraw"));
    assert.equal(result.previewPath, path.join(dir, "report.wb0.png"));
    const scene = JSON.parse(await readFile(result.scenePath, "utf8"));
    assert.equal(scene.type, "excalidraw");
    assert.equal(scene.source, "luxe");
    assert.equal(scene.elements.length, 1);
    // The same appearance strip the sidecar applies - a kept file must not pin
    // a theme either.
    assert.equal("theme" in scene.appState, false);
    assert.ok((await readFile(result.previewPath)).length > 0);
    assert.equal(await isWhiteboardRetained(dir, KEY, 0), true);
  });
});

test("a save with no PNG still writes the scene and reports no preview", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0);
    const result = await saveWhiteboardToMachine(dir, KEY, 0, {
      artifactFile: path.join(dir, "report.html"),
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl: "",
    });

    assert.equal(result.previewPath, "");
    assert.ok(JSON.parse(await readFile(result.scenePath, "utf8")));
    assert.equal(await isWhiteboardRetained(dir, KEY, 0), true);
  });
});

test("F3 exit 1: ending a session deletes its sidecars", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0);
    await seedScene(dir, KEY, 1);
    assert.deepEqual(await listSessionWhiteboards(dir, KEY), [0, 1]);

    assert.equal(await cleanupSessionWhiteboards(dir, KEY), true);

    assert.deepEqual(await listSessionWhiteboards(dir, KEY), []);
    await assert.rejects(readFile(path.join(whiteboardDir(dir, KEY), "0.json")));
  });
});

test("cleanup keeps exactly the retained diagram and deletes the rest", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0);
    await seedScene(dir, KEY, 1);
    await writeWhiteboardFeedbackFiles(dir, KEY, 1, {
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });
    await saveWhiteboardToMachine(dir, KEY, 1, {
      artifactFile: path.join(dir, "report.html"),
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });

    await cleanupSessionWhiteboards(dir, KEY);

    assert.deepEqual(await listSessionWhiteboards(dir, KEY), [1]);
    assert.equal(await isWhiteboardRetained(dir, KEY, 1), true);
    // The copy next to the artifact is untouched by any sweep.
    assert.ok(await readFile(path.join(dir, "report.wb1.excalidraw"), "utf8"));
    assert.ok(await readFile(path.join(dir, "report.wb1.png")));
    // And the feedback files of the retained diagram survive with it.
    const { previewPath } = whiteboardFeedbackPaths(dir, KEY, 1);
    assert.ok(await readFile(previewPath));
  });
});

// A retain marker with no scene beside it is an orphan: it keeps nothing, and
// honouring it pins an empty directory in the state tree forever, because every
// later pass takes the "something is retained" branch and never removes the
// directory itself. That is a permanent leak and a contradiction of D5's
// "ephemeral", so cleanup collects it.
test("cleanup collects a sidecar directory that holds only orphan retain markers", async () => {
  await withTempDir(async (dir) => {
    await saveWhiteboardToMachine(dir, KEY, 3, {
      artifactFile: path.join(dir, "report.html"),
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl: "",
    });
    // No scene was ever autosaved for diagram 3, so the marker is all there is.
    assert.deepEqual(await listSessionWhiteboards(dir, KEY), []);
    assert.equal(await isWhiteboardRetained(dir, KEY, 3), true);

    assert.equal(await cleanupSessionWhiteboards(dir, KEY), true);

    await assert.rejects(readFile(path.join(whiteboardDir(dir, KEY), "3.retain"), "utf8"));
    assert.equal(await isWhiteboardRetained(dir, KEY, 3), false);
    // A second pass has nothing left to do - the directory itself is gone.
    assert.equal(await cleanupSessionWhiteboards(dir, KEY), false);
    // And the kept copy next to the artifact is untouched: it is the user's
    // file now, not state.
    assert.ok(await readFile(path.join(dir, "report.wb3.excalidraw"), "utf8"));
  });
});

test("cleanup on a session that never had a whiteboard is a no-op, not an error", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await cleanupSessionWhiteboards(dir, KEY), false);
    assert.equal(await cleanupSessionWhiteboards(dir, "not-a-key"), false);
  });
});

test("F3 exit 2: a scene equal to its conversion baseline holds no unsaved edits", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0);
    assert.equal(await sessionHasUnsavedWhiteboardEdits(dir, KEY), false);
  });
});

// The sharp edge D5 asked us to blunt: walking away must not destroy work in
// progress, so an edited-but-unkept scene holds the idle cleanup back.
test("F3 exit 2: an edited, unkept scene counts as unsaved edits", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0, {
      elements: [
        { id: "A", type: "rectangle", x: 0, y: 0 },
        { id: "B", type: "freedraw", x: 40, y: 40 },
      ],
      baseline: { elements: [{ id: "A", type: "rectangle", x: 0, y: 0 }] },
    });

    assert.equal(await sessionHasUnsavedWhiteboardEdits(dir, KEY), true);
  });
});

test("F3 exit 2: once kept, the same edits no longer hold cleanup back", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0, {
      elements: [
        { id: "A", type: "rectangle", x: 0, y: 0 },
        { id: "B", type: "freedraw", x: 40, y: 40 },
      ],
      baseline: { elements: [{ id: "A", type: "rectangle", x: 0, y: 0 }] },
    });
    await saveWhiteboardToMachine(dir, KEY, 0, {
      artifactFile: path.join(dir, "report.html"),
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });

    assert.equal(await sessionHasUnsavedWhiteboardEdits(dir, KEY), false);
  });
});

test("F3 exit 3: the startup sweep collects dead sessions and spares live ones", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0);
    await seedScene(dir, OTHER_KEY, 0);

    const swept = await sweepOrphanWhiteboards(dir, [KEY]);

    assert.deepEqual(swept, [OTHER_KEY]);
    assert.deepEqual(await listSessionWhiteboards(dir, KEY), [0]);
    assert.deepEqual(await listSessionWhiteboards(dir, OTHER_KEY), []);
  });
});

test("the startup sweep spares a retained scene even when its session is long gone", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, OTHER_KEY, 0);
    await seedScene(dir, OTHER_KEY, 1);
    await saveWhiteboardToMachine(dir, OTHER_KEY, 1, {
      artifactFile: path.join(dir, "report.html"),
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl: PNG_DATA_URL,
    });

    await sweepOrphanWhiteboards(dir, []);

    assert.deepEqual(await listSessionWhiteboards(dir, OTHER_KEY), [1]);
  });
});

test("the startup sweep ignores anything in the tree that is not a session directory", async () => {
  await withTempDir(async (dir) => {
    await seedScene(dir, KEY, 0);
    await writeFile(path.join(dir, "whiteboards", "stray.txt"), "not ours\n");

    const swept = await sweepOrphanWhiteboards(dir, []);

    assert.deepEqual(swept, [KEY]);
    assert.equal(await readFile(path.join(dir, "whiteboards", "stray.txt"), "utf8"), "not ours\n");
  });
});

test("a sweep of a state directory with no whiteboards at all is a no-op", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await sweepOrphanWhiteboards(dir, []), []);
  });
});
