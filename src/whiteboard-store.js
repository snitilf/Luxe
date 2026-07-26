import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { sanitizeWhiteboardScene, summarizeSceneEdits } from "./whiteboard-core.js";

// Sidecar persistence for whiteboard scenes, kept out of `state.json` on
// purpose: `SessionStore` rewrites the whole state file on every operation, so
// multi-hundred-KB Excalidraw scenes autosaving every second would turn each
// unrelated store write into a large rewrite. Scenes live as one JSON file per
// (session key, diagram index) under `<state-dir>/whiteboards/`, next to the
// published `.excalidraw`/`.png` feedback files the agent reads.
//
// Scenes are review content, so the sidecar tree is owner-only like the rest of the state
// directory: it sits under a 0700 parent (see ensureStateDir) and its own directories are
// created 0700 as well, so the tree stays private even if the parent is ever relaxed.

const KEY_RE = /^[0-9a-f]{16}$/;
const writeTails = new Map();
let temporaryFileId = 0;

export function isValidWhiteboardKey(key) {
  return KEY_RE.test(String(key || ""));
}

// Strict on purpose. The old form was `Number(index)`, which accepts every
// value JavaScript is willing to coerce: `null`, `""`, `[]` and `false` all
// became diagram 0, `true` became 1, and `"0x10"` became 16. Route params reach
// this through `req.params`, so that coercion was the difference between "the
// caller named a diagram" and "the caller sent junk and got diagram 0". An
// index is either an integer in range or a canonical decimal string - no
// leading zeros, no `0x`, no whitespace, nothing to coerce.
const CANONICAL_INDEX_RE = /^(0|[1-9]\d{0,2})$/;

export function isValidDiagramIndex(index) {
  if (typeof index === "number") return Number.isInteger(index) && index >= 0 && index <= 999;
  if (typeof index === "string") return CANONICAL_INDEX_RE.test(index);
  return false;
}

function assertValidRef(key, index) {
  if (!isValidWhiteboardKey(key)) throw new Error(`invalid whiteboard session key: ${key}`);
  if (!isValidDiagramIndex(index)) throw new Error(`invalid whiteboard diagram index: ${index}`);
}

export function whiteboardDir(stateDir, key) {
  return path.join(stateDir, "whiteboards", String(key));
}

function workingFile(stateDir, key, index) {
  return path.join(whiteboardDir(stateDir, key), `${Number(index)}.json`);
}

function writeQueueKey(stateDir, key, index) {
  return `${path.resolve(stateDir)}\u0000${key}\u0000${Number(index)}`;
}

function queueWhiteboardWrite(stateDir, key, index, operation) {
  const queueKey = writeQueueKey(stateDir, key, index);
  const prior = writeTails.get(queueKey) || Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  writeTails.set(queueKey, tail);
  tail.finally(() => {
    if (writeTails.get(queueKey) === tail) writeTails.delete(queueKey);
  });
  return result;
}

async function writeFileAtomically(file, content) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function whiteboardFeedbackPaths(stateDir, key, index) {
  assertValidRef(key, index);
  const dir = whiteboardDir(stateDir, key);
  return {
    scenePath: path.join(dir, `${Number(index)}.excalidraw`),
    previewPath: path.join(dir, `${Number(index)}.png`),
  };
}

// Working state: the editable scene, the conversion baseline used for edit
// summaries, and the hash of the Mermaid source the scene was converted from.
export async function saveWhiteboard(
  stateDir,
  key,
  index,
  { sourceHash, textMetricsVersion = 0, scene, baseline = null },
) {
  assertValidRef(key, index);
  const record = {
    source_hash: String(sourceHash || ""),
    text_metrics_version: Math.max(0, Math.floor(Number(textMetricsVersion) || 0)),
    updated_at: new Date().toISOString(),
    scene: sanitizeWhiteboardScene(scene),
    baseline: baseline ?? null,
  };
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await mkdir(whiteboardDir(stateDir, key), { recursive: true, mode: 0o700 });
    await writeFileAtomically(workingFile(stateDir, key, index), `${JSON.stringify(record)}\n`);
    return record;
  });
}

export async function loadWhiteboard(stateDir, key, index) {
  assertValidRef(key, index);
  try {
    const raw = await readFile(workingFile(stateDir, key, index), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      source_hash: String(parsed.source_hash || ""),
      text_metrics_version: Math.max(0, Math.floor(Number(parsed.text_metrics_version) || 0)),
      updated_at: String(parsed.updated_at || ""),
      scene: parsed.scene ?? null,
      baseline: parsed.baseline ?? null,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// Publish the agent-facing feedback files: a standalone `.excalidraw` scene
// JSON and a PNG preview. Called at queue time so the paths embedded in the
// queued prompt always point at the exact reviewed state.
export async function writeWhiteboardFeedbackFiles(stateDir, key, index, { scene, pngDataUrl = "" }) {
  assertValidRef(key, index);
  const { scenePath, previewPath } = whiteboardFeedbackPaths(stateDir, key, index);
  const sceneJson = excalidrawSceneJson(scene);
  const png = decodePngDataUrl(pngDataUrl);
  return queueWhiteboardWrite(stateDir, key, index, async () => {
    await mkdir(whiteboardDir(stateDir, key), { recursive: true, mode: 0o700 });
    await writeFileAtomically(scenePath, `${JSON.stringify(sceneJson, null, 2)}\n`);
    if (png) {
      await writeFileAtomically(previewPath, png);
      return { scenePath, previewPath };
    }
    return { scenePath, previewPath: "" };
  });
}

// ---------------------------------------------------------------------------
// Ephemeral whiteboards (D5). Scenes autosave to the sidecar exactly as before
// - that persistence is what survives a reload, what the fullscreen editor
// re-opens from, and what the queue-feedback PNG is generated from, so none of
// it changes. What changes is the end of life: the sidecar directory is swept
// when the session goes away, and the only thing that survives a sweep is a
// scene the user explicitly kept.
//
// The retain marker is a sibling file rather than a field inside the sidecar
// JSON on purpose: autosave rewrites that JSON wholesale every eight hundred
// milliseconds, so a field would have to be read back and re-merged on every
// write, and one missed merge would silently un-keep a kept scene.
// ---------------------------------------------------------------------------

function retainMarkerFile(stateDir, key, index) {
  return path.join(whiteboardDir(stateDir, key), `${Number(index)}.retain`);
}

/** Basename an artifact's saved whiteboards hang off: /x/report.html -> report. */
export function artifactWhiteboardBasename(artifactFile) {
  const base = path.basename(String(artifactFile || ""));
  return base.replace(/\.[^.]+$/, "") || base || "artifact";
}

/**
 * Absolute paths of the kept copies for one diagram, next to the artifact.
 * `<N>` is the document-order Mermaid index, the same primary key the sidecar
 * files and the whiteboard routes already use, so no new identifier appears.
 */
export function savedWhiteboardPaths(artifactFile, index) {
  const dir = path.dirname(path.resolve(String(artifactFile || ".")));
  const stem = `${artifactWhiteboardBasename(artifactFile)}.wb${Number(index)}`;
  return {
    scenePath: path.join(dir, `${stem}.excalidraw`),
    previewPath: path.join(dir, `${stem}.png`),
  };
}

export function excalidrawSceneJson(scene) {
  const sanitized = sanitizeWhiteboardScene(scene);
  return {
    type: "excalidraw",
    version: 2,
    source: "luxe",
    elements: Array.isArray(sanitized?.elements) ? sanitized.elements : [],
    appState: sanitized?.appState || {},
    files: sanitized?.files && typeof sanitized.files === "object" ? sanitized.files : {},
  };
}

/**
 * "Save to machine": write the scene and its PNG next to the artifact, then
 * mark the sidecar retained so no cleanup pass deletes it. Both halves are F2's
 * answer - a scene file the user can reopen, and an image they can look at.
 */
export async function saveWhiteboardToMachine(stateDir, key, index, { artifactFile, scene, pngDataUrl = "" }) {
  assertValidRef(key, index);
  const { scenePath, previewPath } = savedWhiteboardPaths(artifactFile, index);
  const png = decodePngDataUrl(pngDataUrl);
  await writeFileAtomically(scenePath, `${JSON.stringify(excalidrawSceneJson(scene), null, 2)}\n`);
  if (png) await writeFileAtomically(previewPath, png);
  await mkdir(whiteboardDir(stateDir, key), { recursive: true, mode: 0o700 });
  await writeFileAtomically(
    retainMarkerFile(stateDir, key, index),
    `${JSON.stringify({ saved_at: new Date().toISOString(), scene_path: scenePath, preview_path: png ? previewPath : "" })}\n`,
  );
  return { scenePath, previewPath: png ? previewPath : "" };
}

export async function isWhiteboardRetained(stateDir, key, index) {
  try {
    await readFile(retainMarkerFile(stateDir, key, index), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Diagram indices that currently have a scene in a session's sidecar directory. */
export async function listSessionWhiteboards(stateDir, key) {
  if (!isValidWhiteboardKey(key)) return [];
  let entries;
  try {
    entries = await readdir(whiteboardDir(stateDir, key));
  } catch {
    return [];
  }
  return entries
    .map((entry) => /^(\d{1,3})\.json$/.exec(entry))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

/** Diagram indices in a session's sidecar directory that carry a retain marker. */
export async function retainedWhiteboardIndices(stateDir, key) {
  let entries;
  try {
    entries = await readdir(whiteboardDir(stateDir, key));
  } catch {
    return new Set();
  }
  const retained = new Set();
  for (const entry of entries) {
    const match = /^(\d{1,3})\.retain$/.exec(entry);
    if (match) retained.add(Number(match[1]));
  }
  return retained;
}

/**
 * True when some whiteboard in this session holds edits the user has not kept:
 * a scene that differs from the conversion baseline and carries no retain
 * marker. Used to hold back idle-shutdown cleanup, so walking away from
 * in-progress work never destroys it (roadmap D5, "the one sharp edge").
 */
export async function sessionHasUnsavedWhiteboardEdits(stateDir, key) {
  if (!isValidWhiteboardKey(key)) return false;
  let entries;
  try {
    entries = await readdir(whiteboardDir(stateDir, key));
  } catch {
    return false;
  }
  const retained = await retainedWhiteboardIndices(stateDir, key);
  for (const entry of entries) {
    const match = /^(\d{1,3})\.json$/.exec(entry);
    if (!match) continue;
    const index = Number(match[1]);
    if (retained.has(index)) continue;
    const record = await loadWhiteboard(stateDir, key, index).catch(() => null);
    if (!record) continue;
    const summary = summarizeSceneEdits(record.baseline?.elements || [], record.scene?.elements || []);
    if (summary.totalChanges > 0) return true;
  }
  return false;
}

/**
 * Retain markers that still have the scene or published files they were
 * written for. `entries` is the already-read directory listing.
 */
function effectiveRetainedIndices(entries) {
  const marked = new Set();
  const companions = new Set();
  for (const entry of entries) {
    const match = /^(\d{1,3})\.(json|excalidraw|png|retain)$/.exec(entry);
    if (!match) continue;
    (match[2] === "retain" ? marked : companions).add(Number(match[1]));
  }
  return new Set([...marked].filter((index) => companions.has(index)));
}

/**
 * Delete a session's sidecar directory minus anything retained. Called on all
 * three exits (F3): explicit session end, idle self-shutdown, and the orphan
 * sweep at server startup. Returns true when anything was removed.
 */
export async function cleanupSessionWhiteboards(stateDir, key) {
  if (!isValidWhiteboardKey(key)) return false;
  const dir = whiteboardDir(stateDir, key);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  // A retain marker only keeps a directory alive while it still keeps
  // something: the marker plus the scene it was written for. A marker with no
  // companion file is an orphan - it happens when a scene is kept and the
  // sidecar is then swept, or when a save lands against an already-swept
  // session - and honouring it would pin an empty directory in the state tree
  // forever, because this function would take the "something is retained"
  // branch on every later pass and never remove the directory itself.
  const retained = effectiveRetainedIndices(entries);
  if (retained.size === 0) {
    await rm(dir, { recursive: true, force: true });
    return entries.length > 0;
  }
  let removed = false;
  for (const entry of entries) {
    const match = /^(\d{1,3})\.(json|excalidraw|png|retain)$/.exec(entry);
    if (match && retained.has(Number(match[1]))) continue;
    await rm(path.join(dir, entry), { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

/**
 * Startup sweep: every sidecar directory whose session is gone or already ended
 * is collected. Sessions that are still open are left alone - a chrome may be
 * about to reconnect to one, and its scenes are still live working state.
 */
export async function sweepOrphanWhiteboards(stateDir, liveKeys) {
  const live = new Set([...(liveKeys || [])].map(String));
  let entries;
  try {
    entries = await readdir(path.join(stateDir, "whiteboards"), { withFileTypes: true });
  } catch {
    return [];
  }
  const swept = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidWhiteboardKey(entry.name) || live.has(entry.name)) continue;
    if (await cleanupSessionWhiteboards(stateDir, entry.name)) swept.push(entry.name);
  }
  return swept;
}

export function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}
