import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The overlay's initial fit is three settings that only work as a set, and each
// one of them was a visible defect on its own:
//
//   fitToViewport        - `fitToContent` caps zoom at 100%, and a converted
//                          Mermaid diagram is small in scene units, so a four
//                          node flowchart opened marooned in an almost empty
//                          canvas, narrower than Excalidraw's toolbar island.
//   maxZoom              - without a cap, fitting a single-node diagram to a
//                          full-viewport canvas magnifies it about ten times.
//   canvasOffsets        - `scrollToContent` never fills this in (every caller
//                          inside Excalidraw passes `getEditorUIOffsets()`, and
//                          that method is not on the public API), so the fit
//                          centres on the raw canvas rect and a full-height
//                          scene opens partly under the floating toolbar.
//
// The frame is a browser entry - it touches `document` at module scope and
// bundles React and Excalidraw - so this reads the source the way
// whiteboard-pins.test.js does rather than importing it.

const frame = readFileSync(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");

test("the initial fit scales the scene to the viewport rather than capping at 100%", () => {
  assert.match(frame, /fitToViewport: true/);
  assert.doesNotMatch(frame, /fitToContent:\s*true/, "fitToContent caps zoom at 100% and marooned small diagrams");
});

test("the initial fit is capped so a small diagram is not magnified into a billboard", () => {
  assert.match(frame, /maxZoom: FIT_MAX_ZOOM/);
  const cap = Number(/const FIT_MAX_ZOOM = ([\d.]+);/.exec(frame)?.[1]);
  assert.ok(cap > 1, "a cap of 1 or less would defeat fitToViewport");
  assert.ok(cap <= 3, `a converted diagram must not open past 3x its natural size, got ${cap}`);
});

test("the initial fit leaves margin around the scene", () => {
  assert.match(frame, /viewportZoomFactor: FIT_VIEWPORT_ZOOM_FACTOR/);
  const factor = Number(/const FIT_VIEWPORT_ZOOM_FACTOR = ([\d.]+);/.exec(frame)?.[1]);
  // Excalidraw clamps this into 0.1..1; 1 means edge to edge, which is the
  // "no space around it" the factor exists to prevent.
  assert.ok(factor >= 0.1 && factor < 1, `viewportZoomFactor must leave margin and stay in range, got ${factor}`);
});

test("the initial fit keeps the scene clear of Excalidraw's floating toolbar", () => {
  assert.match(frame, /canvasOffsets: editorUIOffsets\(/);
  // The frame's canvas is offset from the top of its document by the shell
  // header, so the toolbar's clearance has to be measured relative to the
  // editor container, not to the viewport as Excalidraw does it internally.
  assert.match(frame, /toolbarRect\.bottom - containerRect\.top/);
});

test("the fit degrades to plain padding instead of throwing when Excalidraw renames its toolbar", () => {
  assert.match(frame, /querySelector\?\.\(["'`]\.App-toolbar["'`]\)\?\./);
  assert.match(frame, /top: FIT_EDGE_PADDING/);
});
