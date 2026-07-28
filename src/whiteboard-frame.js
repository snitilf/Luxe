/* global document, window, FileReader, location */

// Browser entry for the whiteboard frame. Luxe is fullscreen-first: there is
// exactly one placement, the chrome's full-viewport overlay, opened when the
// reader presses the quiet Edit affordance the artifact SDK draws over a
// rendered Mermaid diagram. The inline diagram itself stays plain themed
// Mermaid - no nested editor, no hidden container - so a page of diagrams
// scrolls and prints like a page.
//
// This is a scoped rewrite of the two-placement upstream, not a subtraction.
// Everything the editor needs to be trustworthy was built unconditionally for
// both placements and is kept here verbatim: the note field, the image-fallback
// banner, the stale-source banner with its re-convert-versus-keep-editing
// prompt (the guard that keeps stale edits from ever merging silently), the
// status line, and `state.setLocked`, which the teardown flush uses to freeze
// the canvas while the final save is in flight.
//
// The frame is sandboxed (`allow-scripts allow-popups`, no `allow-same-origin`)
// and bundled by `scripts/build.js` (esbuild) together with Excalidraw, the
// Mermaid converter, its own exactly-pinned mermaid, and React into
// `dist/whiteboard/whiteboard.js`, so nothing here loads from the network.
//
// The frame owns all whiteboard UI. It holds no server access; the chrome does
// the same-origin fetches. Untrusted Mermaid text therefore renders only
// inside opaque origins, exactly like the artifact iframe.

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import {
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  exportToCanvas,
  FONT_FAMILY,
  restore,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./whiteboard-frame.css";

import { LUXE_MERMAID_THEME_VARIABLES, LUXE_WHITEBOARD_CANVAS_BACKGROUND } from "./mermaid-theme.js";
import {
  convertExcalidrawSkeletonsAfterFontsLoad,
  createWhiteboardPersistencePayload,
  findDuplicateElementIds,
  repairSavedSceneTextMetrics,
  sanitizeSceneLink,
  sanitizeWhiteboardAppState,
  sceneIsImageFallback,
  summarizeSceneEdits,
  WHITEBOARD_TEXT_METRICS_VERSION,
} from "./whiteboard-core.js";

const SAVE_DEBOUNCE_MS = 800;
// "Save to machine" is the one control whose busy state is cleared by a reply
// from the chrome rather than by anything inside this frame. If that reply never
// arrives - the overlay is torn down mid-flight, the chrome navigates, the
// channel is gone - the button would stay disabled for the life of the frame.
// The timeout is the floor under that: generous enough that a large PNG write
// on a slow disk finishes first, short enough that the user is not stuck.
const SAVE_TO_MACHINE_TIMEOUT_MS = 20000;

// Initial-fit geometry. See `fitSceneToViewport` for why each of these exists.
// The factor is the share of the free canvas the scene is allowed to fill, so
// 0.8 leaves a tenth of the shorter axis as breathing room on each side. The
// cap is what keeps a one-node diagram from being blown up into a billboard:
// nothing converted is ever magnified past twice its natural size.
const FIT_VIEWPORT_ZOOM_FACTOR = 0.8;
const FIT_MAX_ZOOM = 2;
// Excalidraw's own gap between its floating UI and fitted content.
const FIT_EDGE_PADDING = 16;

const state = {
  diagramIndex: 0,
  diagramId: "",
  // Hash of the Mermaid source this scene was converted from. Stays at the old
  // value when the user keeps editing a saved scene after the diagram changed
  // underneath, so feedback honestly reports which source the edits refer to.
  sceneSourceHash: "",
  currentSource: "",
  currentSourceHash: "",
  baselineElements: [],
  files: {},
  imageFallback: false,
  textMetricsVersion: WHITEBOARD_TEXT_METRICS_VERSION,
  channelId: "",
  api: null,
  saveTimer: 0,
  teardownFlushId: "",
  flushIds: new Set(),
  queueBusy: false,
  saveBusy: false,
  saveToMachineTimer: 0,
  // Load-bearing in the overlay teardown flush, not a leftover of the inline
  // placement: `prepareTeardown` locks the canvas into view mode so no edit can
  // land between the final save being posted and the overlay closing.
  setLocked: null,
};

function post(message) {
  window.top.postMessage(
    {
      ...message,
      diagramIndex: state.diagramIndex,
      ...(state.channelId
        ? { channelId: state.channelId }
        : {
            channelToken: String(/** @type {any} */ (window).__luxeWhiteboardChannelToken || ""),
            diagramId: state.diagramId,
          }),
    },
    "*",
  );
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function setBanner(id, text) {
  const banner = document.getElementById(id);
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = !text;
}

function buildShell() {
  const shell = el("div", { id: "wbShell" });
  const header = el("header", { id: "wbHeader" });
  const title = el("div", { id: "wbTitle", textContent: "Whiteboard" });
  const note = el("input", {
    id: "wbNote",
    placeholder: "Optional note for the agent about these edits...",
    autocomplete: "off",
  });
  // Ephemeral by default (D5): the scene autosaves to the session sidecar and
  // is swept when the session goes away. "Save to machine" is the explicit
  // keep, writing the scene and a PNG next to the artifact and marking the
  // sidecar retained so no cleanup pass touches it again.
  const saveButton = el("button", {
    id: "wbSaveToMachine",
    type: "button",
    textContent: "Save to machine",
    title: "Write this whiteboard next to the artifact as .excalidraw and .png",
  });
  const queueButton = el("button", { id: "wbQueue", type: "button", textContent: "Queue feedback" });
  // The chrome renders the close control on top of this header's right edge (it
  // must work even when this frame fails to boot), so the header reserves that
  // space via CSS instead of adding its own close.
  header.append(title, note, saveButton, queueButton);
  const fallbackBanner = el("div", { id: "wbFallbackBanner", className: "wb-banner", hidden: true });
  const staleBanner = el("div", { id: "wbStaleBanner", className: "wb-banner wb-banner-warn", hidden: true });
  const status = el("div", { id: "wbStatus", className: "wb-status", hidden: true });
  const editor = el("div", { id: "wbEditor" });
  const linkConfirm = el("div", { id: "wbLinkConfirm", className: "wb-link-confirm", hidden: true });
  linkConfirm.setAttribute("role", "dialog");
  linkConfirm.setAttribute("aria-modal", "true");
  linkConfirm.setAttribute("aria-label", "Open external link");
  const linkConfirmCard = el("div", { className: "wb-link-confirm-card" });
  const linkConfirmTitle = el("div", { className: "wb-link-confirm-title", textContent: "Open external link?" });
  const linkConfirmCopy = el("p", {
    className: "wb-link-confirm-copy",
    textContent: "This link came from the diagram.",
  });
  const linkConfirmUrl = el("p", { id: "wbLinkConfirmUrl", className: "wb-link-confirm-url" });
  const linkConfirmActions = el("div", { className: "wb-link-confirm-actions" });
  const linkConfirmCancel = el("button", {
    id: "wbLinkConfirmCancel",
    type: "button",
    textContent: "Cancel",
  });
  const linkConfirmOpen = el("button", {
    id: "wbLinkConfirmOpen",
    type: "button",
    textContent: "Open link",
  });
  linkConfirmActions.append(linkConfirmCancel, linkConfirmOpen);
  linkConfirmCard.append(linkConfirmTitle, linkConfirmCopy, linkConfirmUrl, linkConfirmActions);
  linkConfirm.append(linkConfirmCard);
  shell.append(header, fallbackBanner, staleBanner, status, editor, linkConfirm);
  document.body.append(shell);

  queueButton.onclick = () => queueFeedback().catch((error) => showStatus(`Queue failed: ${describeError(error)}`));
  saveButton.onclick = () => saveToMachine().catch((error) => showStatus(`Save failed: ${describeError(error)}`));
  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      queueButton.click();
    }
  });
  linkConfirmCancel.onclick = dismissLinkConfirmation;
  linkConfirmOpen.onclick = () => {
    const safe = String(linkConfirm.dataset.url || "");
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
    dismissLinkConfirmation();
  };
  linkConfirm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissLinkConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [linkConfirmCancel, linkConfirmOpen];
    const activeIndex = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const nextIndex = event.shiftKey ? activeIndex - 1 : activeIndex + 1;
    if (nextIndex >= 0 && nextIndex < buttons.length) return;
    event.preventDefault();
    buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
  });
}

let statusTimer = 0;
function showStatus(text, { transient = true } = {}) {
  const status = document.getElementById("wbStatus");
  if (!status) return;
  status.textContent = text;
  status.hidden = !text;
  if (transient && text) {
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.hidden = true;
    }, 4000);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function currentScene() {
  if (!state.api) return null;
  const appState = state.api.getAppState();
  return {
    elements: state.api.getSceneElements().map((element) => JSON.parse(JSON.stringify(element))),
    appState: sanitizeWhiteboardAppState({
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    }),
    files: state.api.getFiles() || {},
  };
}

function postSave(flushId = "") {
  const scene = currentScene();
  if (!scene) return false;
  post({
    type: "luxe-whiteboard:save",
    diagramIndex: state.diagramIndex,
    ...createWhiteboardPersistencePayload(state, scene),
    ...(flushId ? { flushId } : {}),
  });
  return true;
}

function scheduleSave() {
  if (state.teardownFlushId) return;
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    postSave();
  }, SAVE_DEBOUNCE_MS);
}

function prepareTeardown(message) {
  const flushId = String(message.flushId || "");
  if (!flushId) return;
  state.teardownFlushId = flushId;
  window.clearTimeout(state.saveTimer);
  state.setLocked?.(true);
  if (!postSave(flushId)) {
    state.teardownFlushId = "";
    post({ type: "luxe-whiteboard:teardownReady", flushId });
  }
}

function flushSaveNow(message) {
  const flushId = String(message.flushId || "");
  if (!flushId || state.flushIds.has(flushId)) return;
  state.flushIds.add(flushId);
  window.clearTimeout(state.saveTimer);
  if (!postSave(flushId)) {
    state.flushIds.delete(flushId);
    post({ type: "luxe-whiteboard:flushComplete", flushId, ok: true });
  }
}

function handleSaveResult(message) {
  const flushId = String(message.flushId || "");
  if (!flushId) return;
  if (flushId === state.teardownFlushId) {
    state.teardownFlushId = "";
    if (message.ok) {
      post({ type: "luxe-whiteboard:teardownReady", flushId });
      return;
    }
    state.setLocked?.(false);
    const error = String(message.error || "failed to save whiteboard scene");
    showStatus(`Could not save before closing: ${error}`, { transient: false });
    post({ type: "luxe-whiteboard:teardownFailed", flushId, error });
    return;
  }
  if (state.flushIds.delete(flushId)) {
    post({ type: "luxe-whiteboard:flushComplete", flushId, ok: Boolean(message.ok) });
  }
}

/** @type {{ focus?: () => void } | null} */
let linkConfirmationReturnFocus = null;

function dismissLinkConfirmation() {
  const dialog = document.getElementById("wbLinkConfirm");
  if (dialog) dialog.hidden = true;
  const returnFocus = linkConfirmationReturnFocus;
  linkConfirmationReturnFocus = null;
  returnFocus?.focus?.();
}

function showLinkConfirmation(safe) {
  const dialog = document.getElementById("wbLinkConfirm");
  const url = document.getElementById("wbLinkConfirmUrl");
  const cancel = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbLinkConfirmCancel"));
  if (!dialog || !url || !cancel) return;
  const activeElement = /** @type {{ focus?: () => void } | null} */ (document.activeElement);
  linkConfirmationReturnFocus = activeElement && typeof activeElement.focus === "function" ? activeElement : null;
  dialog.dataset.url = safe;
  url.textContent = safe;
  dialog.hidden = false;
  cancel.focus();
}

function onLinkOpen(element, event) {
  event.preventDefault();
  const safe = sanitizeSceneLink(element?.link);
  if (!safe) {
    showStatus("Blocked a link with an unsupported or unsafe scheme.");
    return;
  }
  showLinkConfirmation(safe);
}

// The area of the canvas the initial fit is allowed to use, measured the way
// Excalidraw measures it for its own fits. `scrollToContent` accepts
// `canvasOffsets` but never fills it in: every internal caller hands it
// `getEditorUIOffsets()`, and that method is not on the public
// `excalidrawAPI`. Passing nothing means the fit centres on the raw canvas
// rect, so the scene is laid out as if the floating toolbar island were not
// there and a full-height scene opens partly underneath it.
//
// Only the top row exists at mount time - the left properties panel appears
// with a selection, the sidebar with the library - so this measures the
// toolbar and leaves the other three edges at Excalidraw's own padding. The
// rect lookup is read-only and falls back to plain padding, so an upstream
// class rename costs the top clearance and nothing else.
function editorUIOffsets(container) {
  const offsets = {
    top: FIT_EDGE_PADDING,
    right: FIT_EDGE_PADDING,
    bottom: FIT_EDGE_PADDING,
    left: FIT_EDGE_PADDING,
  };
  const containerRect = container?.getBoundingClientRect?.();
  const toolbarRect = container?.querySelector?.(".App-toolbar")?.getBoundingClientRect?.();
  if (containerRect && toolbarRect) {
    offsets.top = Math.max(toolbarRect.bottom - containerRect.top, 0) + FIT_EDGE_PADDING;
  }
  return offsets;
}

// A converted Mermaid diagram is usually small in scene units - four boxes and
// three arrows is under a thousand points wide - while the overlay canvas is
// the whole viewport. `fitToContent` caps zoom at 100%, so such a scene opened
// marooned in a mostly empty canvas at a size where Excalidraw's own toolbar
// island was wider than the entire diagram. `fitToViewport` lifts that cap and
// actually uses the space; `FIT_MAX_ZOOM` is what stops it turning a single
// node into a billboard, and `FIT_VIEWPORT_ZOOM_FACTOR` is the margin.
function fitSceneToViewport(api) {
  try {
    const elements = api.getSceneElements();
    if (!elements || elements.length === 0) return;
    api.scrollToContent(elements, {
      fitToViewport: true,
      viewportZoomFactor: FIT_VIEWPORT_ZOOM_FACTOR,
      maxZoom: FIT_MAX_ZOOM,
      canvasOffsets: editorUIOffsets(document.getElementById("wbEditor")),
    });
  } catch {
    // The fit is cosmetic; initialData's scrollToContent already centred us.
  }
}

// The overlay owns the viewport, so the editor starts unlocked - there is no
// page behind it whose scrolling could be trapped. `setLocked` is still exposed
// on `state` because the teardown flush locks the canvas while the last save is
// in flight, and unlocks it again if that save fails.
function EditorApp({ elements, appState, files }) {
  const [locked, setLocked] = React.useState(false);
  state.setLocked = setLocked;
  return React.createElement(
    "div",
    { style: { position: "relative", width: "100%", height: "100%" } },
    React.createElement(Excalidraw, {
      initialData: { elements, appState, files: files || undefined, scrollToContent: true },
      // Light only. The theme must reach Excalidraw through this prop alone -
      // putting it in appState as well double-applies the invert filter and
      // washes the canvas out (see whiteboard-core's persistence strip).
      theme: "light",
      viewModeEnabled: locked,
      onChange: scheduleSave,
      onLinkOpen,
      excalidrawAPI: (api) => {
        state.api = api;
        window.setTimeout(() => fitSceneToViewport(api), 0);
      },
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: false,
        },
      },
    }),
    // Only the teardown flush locks the canvas now, so this catcher is the
    // visible "your last edit is being saved" state rather than an unlock
    // affordance. It deliberately swallows input instead of offering a way out.
    locked
      ? React.createElement(
          "div",
          { className: "wb-activate", "aria-live": "polite" },
          React.createElement("span", { className: "wb-activate-label" }, "Saving your edits..."),
        )
      : null,
  );
}

function mountEditor({ elements, appState, files }) {
  const editorHost = document.getElementById("wbEditor");
  const root = createRoot(editorHost);
  root.render(React.createElement(EditorApp, { elements, appState, files }));
}

const textMetricsCanvas = document.createElement("canvas");
const textMetricsContext = textMetricsCanvas.getContext("2d");

function fontFamilyName(fontFamily) {
  return Object.entries(FONT_FAMILY).find(([, value]) => value === fontFamily)?.[0] || "Segoe UI Emoji";
}

function fontString(element) {
  const family = fontFamilyName(element.fontFamily);
  const families = family === "Excalifont" ? [family, "Xiaolai", "Segoe UI Emoji"] : [family, "Segoe UI Emoji"];
  return `${Number(element.fontSize) || 20}px ${families.map((value) => JSON.stringify(value)).join(", ")}`;
}

function measureSceneText(element) {
  if (!textMetricsContext) return { width: Number(element.width) || 0, height: Number(element.height) || 0 };
  textMetricsContext.font = fontString(element);
  const lines = String(element.text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "        ")
    .split("\n");
  const width = Math.max(...lines.map((line) => textMetricsContext.measureText(line || " ").width));
  const height = lines.length * (Number(element.fontSize) || 20) * (Number(element.lineHeight) || 1.25);
  return { width, height };
}

async function loadSceneFonts(elements, files) {
  const textElements = elements.filter((element) => element.type === "text" && !element.isDeleted);
  if (textElements.length === 0) return;
  await exportToCanvas({
    elements,
    appState: { exportBackground: false },
    files: files || null,
    maxWidthOrHeight: 1,
  });
  await Promise.all(
    textElements.map((element) => document.fonts.load(fontString(element), String(element.text || ""))),
  );
  await document.fonts.ready;
}

async function convertSource(source) {
  // The full Luxe block, imported rather than restated, so a converted scene
  // opens in the same palette as the inline diagram it came from. This call
  // site also drives Excalidraw's synchronous text measurement, so changing any
  // value here (fontFamily and fontSize above all) changes glyph metrics for
  // every scene ever saved - which is why WHITEBOARD_TEXT_METRICS_VERSION must
  // be bumped in lockstep.
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(source, {
    themeVariables: LUXE_MERMAID_THEME_VARIABLES,
  });
  const materialize = (input) => {
    // Preserve Mermaid node/edge identity for edit summaries; regenerate only
    // when upstream emitted colliding ids (parallel edges), where uniqueness
    // matters more than identity.
    let elements = convertToExcalidrawElements(input, { regenerateIds: false });
    if (findDuplicateElementIds(elements).length > 0) {
      elements = convertToExcalidrawElements(input, { regenerateIds: true });
    }
    return elements;
  };
  const elements = await convertExcalidrawSkeletonsAfterFontsLoad(skeletons, {
    convert: materialize,
    loadFonts: async (fallbackElements) => {
      await loadSceneFonts(fallbackElements, files);
    },
  });
  return { elements, files: files || {}, imageFallback: sceneIsImageFallback(elements) };
}

// Theme is passed only through the <Excalidraw theme> prop - putting it in
// appState as well double-applies the invert filter and washes the canvas out.
// The background is the Luxe canvas, so an Excalidraw scene sits on the same
// paper as the artifact page around it. It is supplied fresh on every mount
// because whiteboard-core strips viewBackgroundColor at the persistence
// boundary; that strip is what lets a token change repaint every saved scene.
function defaultAppState() {
  return {
    viewBackgroundColor: LUXE_WHITEBOARD_CANVAS_BACKGROUND,
  };
}

async function startFromConversion(init) {
  const { elements, files, imageFallback } = await convertSource(init.source);
  state.baselineElements = JSON.parse(JSON.stringify(elements));
  state.files = files;
  state.imageFallback = imageFallback;
  state.sceneSourceHash = init.sourceHash;
  state.textMetricsVersion = WHITEBOARD_TEXT_METRICS_VERSION;
  if (imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({ elements, appState: defaultAppState(), files });
  scheduleSave();
}

async function startFromSavedScene(init) {
  const saved = init.saved;
  const savedAppState = sanitizeWhiteboardAppState(saved.scene?.appState);
  // restore() is Excalidraw's defensive loader: it fills missing fields with
  // defaults and repairs bindings, so a stale or hand-edited sidecar cannot
  // crash the editor.
  const restored = restore(
    {
      elements: Array.isArray(saved.scene?.elements) ? saved.scene.elements : [],
      appState: savedAppState,
      files: saved.scene?.files || {},
    },
    null,
    null,
    { repairBindings: true },
  );
  let elements = restored.elements;
  let baselineElements = Array.isArray(saved.baseline?.elements)
    ? JSON.parse(JSON.stringify(saved.baseline.elements))
    : JSON.parse(JSON.stringify(restored.elements));
  state.files = restored.files || saved.scene?.files || {};
  const savedMetricsVersion = Number(saved.text_metrics_version) || 0;
  if (savedMetricsVersion < WHITEBOARD_TEXT_METRICS_VERSION) {
    await loadSceneFonts(elements, state.files);
    elements = repairSavedSceneTextMetrics(elements, { measure: measureSceneText }).elements;
    baselineElements = repairSavedSceneTextMetrics(baselineElements, { measure: measureSceneText }).elements;
  }
  state.baselineElements = baselineElements;
  state.textMetricsVersion = WHITEBOARD_TEXT_METRICS_VERSION;
  state.imageFallback = sceneIsImageFallback(elements);
  state.sceneSourceHash = saved.source_hash || init.sourceHash;
  if (state.imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({
    elements,
    appState: { ...defaultAppState(), ...savedAppState },
    files: state.files,
  });
  if (savedMetricsVersion < WHITEBOARD_TEXT_METRICS_VERSION) scheduleSave();
}

// The saved scene was converted from a different version of the diagram. Never
// merge silently: the user explicitly picks between re-converting (discarding
// edits) and continuing on the saved scene.
function offerStaleChoice() {
  const staleBanner = document.getElementById("wbStaleBanner");
  staleBanner.textContent = "This diagram changed since these whiteboard edits were saved. ";
  const reconvert = el("button", { type: "button", textContent: "Re-convert (discard saved edits)" });
  const keep = el("button", { type: "button", textContent: "Keep editing saved scene" });
  staleBanner.append(reconvert, keep);
  staleBanner.hidden = false;
  return new Promise((resolve) => {
    reconvert.onclick = () => {
      staleBanner.hidden = true;
      resolve("reconvert");
    };
    keep.onclick = () => {
      staleBanner.textContent =
        "Editing a scene converted from an older version of this diagram. Re-open the whiteboard to convert the latest diagram.";
      resolve("keep");
    };
  });
}

async function queueFeedback() {
  if (!state.api || state.queueBusy) return;
  state.queueBusy = true;
  const queueButton = /** @type {HTMLButtonElement} */ (document.getElementById("wbQueue"));
  queueButton.disabled = true;
  queueButton.textContent = "Queueing...";
  try {
    const scene = currentScene();
    const summary = summarizeSceneEdits(state.baselineElements, scene.elements);
    const pngDataUrl = await exportScenePng();
    post({
      type: "luxe-whiteboard:queueFeedback",
      diagramIndex: state.diagramIndex,
      diagramId: state.diagramId,
      ...createWhiteboardPersistencePayload(state, scene),
      imageFallback: state.imageFallback,
      note: String(/** @type {HTMLInputElement} */ (document.getElementById("wbNote")).value || "").trim(),
      summaryLines: summary.lines,
      stats: summary.stats,
      pngDataUrl,
    });
  } catch (error) {
    resetQueueButton();
    throw error;
  }
}

// The queue-feedback PNG and the save-to-machine PNG are the same image, and
// both must land on Luxe paper rather than Excalidraw's default white: the
// agent and the user see this file, not the canvas. The live appState carries
// the mounted background (whiteboard-core strips it before persistence), so the
// fallback is the same token rather than white.
async function exportScenePng() {
  const appState = state.api.getAppState();
  const blob = await exportToBlob({
    elements: state.api.getSceneElements(),
    appState: {
      exportBackground: true,
      viewBackgroundColor: appState.viewBackgroundColor || LUXE_WHITEBOARD_CANVAS_BACKGROUND,
    },
    files: state.api.getFiles() || null,
    mimeType: "image/png",
  });
  return blobToDataUrl(blob);
}

// D5's explicit keep. Everything else about the save protocol is untouched:
// this writes a copy next to the artifact and marks the sidecar retained, it
// does not change what or when the editor autosaves.
async function saveToMachine() {
  if (!state.api || state.saveBusy) return;
  state.saveBusy = true;
  const saveButton = /** @type {HTMLButtonElement} */ (document.getElementById("wbSaveToMachine"));
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    const scene = currentScene();
    const pngDataUrl = await exportScenePng();
    post({
      type: "luxe-whiteboard:saveToMachine",
      diagramIndex: state.diagramIndex,
      ...createWhiteboardPersistencePayload(state, scene),
      pngDataUrl,
    });
    window.clearTimeout(state.saveToMachineTimer);
    state.saveToMachineTimer = window.setTimeout(() => {
      resetSaveButton();
      showStatus("Save to machine got no reply. It may not have been written - try again.", { transient: false });
    }, SAVE_TO_MACHINE_TIMEOUT_MS);
  } catch (error) {
    resetSaveButton();
    throw error;
  }
}

function resetSaveButton() {
  window.clearTimeout(state.saveToMachineTimer);
  state.saveToMachineTimer = 0;
  state.saveBusy = false;
  const saveButton = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbSaveToMachine"));
  if (saveButton) {
    saveButton.disabled = false;
    saveButton.textContent = "Save to machine";
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("could not encode PNG preview"));
    reader.readAsDataURL(blob);
  });
}

function resetQueueButton() {
  state.queueBusy = false;
  const queueButton = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbQueue"));
  if (queueButton) {
    queueButton.disabled = false;
    queueButton.textContent = "Queue feedback";
  }
}

async function handleInit(init) {
  state.diagramIndex = Number(init.diagramIndex) || 0;
  state.diagramId = String(init.diagramId || "");
  state.currentSource = String(init.source || "");
  state.currentSourceHash = String(init.sourceHash || "");
  document.getElementById("wbTitle").textContent = `Whiteboard · diagram ${state.diagramIndex + 1}`;

  const saved = init.saved && typeof init.saved === "object" && init.saved.scene ? init.saved : null;
  try {
    if (!saved) {
      await startFromConversion(init);
      return;
    }
    if (saved.source_hash === init.sourceHash) {
      await startFromSavedScene({ ...init, saved });
      return;
    }
    // Stale source. This choice is the guard that keeps edits made against an
    // older diagram from merging into a newer one without the user saying so.
    const choice = await offerStaleChoice();
    if (choice === "keep") {
      await startFromSavedScene({ ...init, saved });
    } else {
      await startFromConversion(init);
    }
  } catch (error) {
    showStatus(`Could not open this diagram as a whiteboard: ${describeError(error)}`, { transient: false });
  }
}

function handleSourceChanged(message) {
  state.currentSource = String(message.source || "");
  state.currentSourceHash = String(message.sourceHash || "");
  if (state.currentSourceHash !== state.sceneSourceHash) {
    setBanner(
      "wbStaleBanner",
      "The underlying diagram changed while you were editing. Your edits are kept; close and re-open the whiteboard to convert the latest diagram.",
    );
  } else {
    setBanner("wbStaleBanner", "");
  }
}

function main() {
  /** @type {any} */ (window).EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;
  const frameUrl = new URL(location.href);
  const diagramIndex = Number(frameUrl.searchParams.get("diagramIndex"));
  state.diagramIndex = Number.isInteger(diagramIndex) && diagramIndex >= 0 && diagramIndex <= 999 ? diagramIndex : 0;
  state.diagramId = String(frameUrl.searchParams.get("diagramId") || "");
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (event.source !== window.top) return;
    const msg = event.data || {};
    if (msg.type === "luxe-whiteboard:init" && !initialized && typeof msg.channelId === "string" && msg.channelId) {
      initialized = true;
      state.channelId = msg.channelId;
      buildShell();
      handleInit(msg);
    }
    if (!initialized || msg.channelId !== state.channelId) return;
    if (msg.type === "luxe-whiteboard:sourceChanged") handleSourceChanged(msg);
    if (msg.type === "luxe-whiteboard:prepareTeardown") prepareTeardown(msg);
    if (msg.type === "luxe-whiteboard:flush") flushSaveNow(msg);
    if (msg.type === "luxe-whiteboard:saveResult") handleSaveResult(msg);
    if (msg.type === "luxe-whiteboard:saveToMachineResult") {
      resetSaveButton();
      if (msg.ok) {
        showStatus(
          `Saved to ${String(msg.scenePath || "")}${msg.previewPath ? ` and ${String(msg.previewPath)}` : ""}`,
          {
            transient: false,
          },
        );
      } else {
        showStatus(`Save failed: ${String(msg.error || "unknown error")}`, { transient: false });
      }
    }
    if (msg.type === "luxe-whiteboard:queueResult") {
      resetQueueButton();
      if (msg.ok) {
        const note = /** @type {HTMLInputElement | null} */ (document.getElementById("wbNote"));
        if (note) note.value = "";
        showStatus("Queued. Review it in the conversation panel, then Send to Agent.");
      } else {
        showStatus(`Queue failed: ${String(msg.error || "unknown error")}`, { transient: false });
      }
    }
  });
  // Escape closes the overlay even when the canvas holds focus. The chrome listens for
  // Escape on its own document, but this frame is a separate document in a sandboxed
  // iframe, so a keystroke aimed at the Excalidraw canvas never reached it and the only
  // way out was the close button. Reuses the existing `luxe-whiteboard:close` message
  // rather than inventing a second way to say the same thing.
  //
  // Two guards, both about not stealing an Escape that already means something here: a
  // text field is being edited (Escape cancels the edit), or the link confirmation is
  // open (it handles its own Escape above, and the event bubbles to this listener after).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const active = document.activeElement;
    const tag = active?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || /** @type {HTMLElement | null} */ (active)?.isContentEditable) return;
    post({ type: "luxe-whiteboard:close" });
  });

  post({ type: "luxe-whiteboard:ready" });
}

main();
