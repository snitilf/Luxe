import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  annotationCardCanDismiss,
  buildDomSnapshot,
  buildStructuralSelector,
  classifyMaterialRectEscape,
  classifySevereTextOverflow,
  DOM_SNAPSHOT_TRUNCATION_MARKER,
  deriveLuxeQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
} from "../src/artifact-sdk.js";
import { token, wcagContrast } from "./helpers/design-tokens.js";

function node(tag, attrs = {}, children = []) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSelectorList(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selector) {
      return matchesSelectorList(this, selector);
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  if (attrs.id) el.id = attrs.id;
  if (attrs.name) el.name = attrs.name;
  if (attrs.type) el.type = attrs.type;
  if (attrs.value) el.value = attrs.value;
  for (const child of children) append(el, child);
  return el;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function snapshotNode(tag, text, children = [], visibility = { includeSelf: true, traverseChildren: true }) {
  return {
    tag,
    text,
    visibility,
    children,
  };
}

function snapshotOptions(overrides = {}) {
  let nextUid = 0;
  return {
    isElement: (element) => Boolean(element?.tag),
    visibility: (element) => element.visibility,
    isExcluded: () => false,
    describe: (element) => ({ uid: String(++nextUid), tag: element.tag, text: element.text }),
    ...overrides,
  };
}

test("buildDomSnapshot excludes hidden subtrees and their text", () => {
  const root = snapshotNode("body", "Visible heading", [
    snapshotNode("section", "Visible answer"),
    snapshotNode("section", "Hidden secret", [snapshotNode("span", "Nested secret")], {
      includeSelf: false,
      traverseChildren: false,
    }),
  ]);

  const snapshot = buildDomSnapshot(root, snapshotOptions());

  assert.match(snapshot, /Visible heading/);
  assert.match(snapshot, /Visible answer/);
  assert.doesNotMatch(snapshot, /Hidden secret|Nested secret/);
});

test("buildDomSnapshot caps visible nodes and appends a truncation marker", () => {
  const root = snapshotNode(
    "body",
    "Root",
    Array.from({ length: 10 }, (_, index) => snapshotNode("p", `Node ${index}`)),
  );

  const snapshot = buildDomSnapshot(root, snapshotOptions({ maxNodes: 3, maxBytes: 10_000 }));

  assert.equal(snapshot.split("\n").filter((line) => line.includes("uid=")).length, 3);
  assert.equal(snapshot.endsWith(DOM_SNAPSHOT_TRUNCATION_MARKER), true);
});

test("buildDomSnapshot caps UTF-8 bytes and appends a truncation marker", () => {
  const root = snapshotNode("body", "é".repeat(80), [snapshotNode("p", "must not fit")]);
  const maxBytes = new TextEncoder().encode(`${DOM_SNAPSHOT_TRUNCATION_MARKER}\n`).byteLength + 48;

  const snapshot = buildDomSnapshot(root, snapshotOptions({ maxNodes: 100, maxBytes }));

  assert.ok(new TextEncoder().encode(snapshot).byteLength <= maxBytes);
  assert.equal(snapshot.endsWith(DOM_SNAPSHOT_TRUNCATION_MARKER), true);
  assert.doesNotMatch(snapshot, /must not fit/);
});

test("buildDomSnapshot traverses non-rendering containers to visible descendants", () => {
  const root = snapshotNode("body", "Root", [
    snapshotNode("div", "Display contents", [snapshotNode("span", "Visible child")], {
      includeSelf: false,
      traverseChildren: true,
    }),
    snapshotNode("section", "Visibility hidden", [snapshotNode("strong", "Explicitly visible child")], {
      includeSelf: false,
      traverseChildren: true,
    }),
  ]);

  const snapshot = buildDomSnapshot(root, snapshotOptions());

  assert.doesNotMatch(snapshot, /Display contents|Visibility hidden/);
  assert.match(snapshot, /Visible child/);
  assert.match(snapshot, /Explicitly visible child/);
});

test("buildDomSnapshot counts hidden nodes toward the traversal limit", () => {
  const hidden = { includeSelf: false, traverseChildren: false };
  const root = snapshotNode("body", "Root", [
    ...Array.from({ length: 5 }, (_, index) => snapshotNode("span", `Hidden ${index}`, [], hidden)),
    snapshotNode("p", "Visible sentinel"),
  ]);

  const snapshot = buildDomSnapshot(root, snapshotOptions({ maxNodes: 6, maxBytes: 10_000 }));

  assert.doesNotMatch(snapshot, /Visible sentinel/);
  assert.equal(snapshot.endsWith(DOM_SNAPSHOT_TRUNCATION_MARKER), true);
});

test("buildDomSnapshot omits the marker when all inspected nodes fit exactly", () => {
  const root = snapshotNode("body", "Root", [snapshotNode("p", "Child")]);

  const snapshot = buildDomSnapshot(root, snapshotOptions({ maxNodes: 2, maxBytes: 10_000 }));

  assert.match(snapshot, /Child/);
  assert.equal(snapshot.includes(DOM_SNAPSHOT_TRUNCATION_MARKER), false);
});

function matchesSelectorList(el, selectorList) {
  return selectorList.split(",").some((selector) => matchesSelector(el, selector.trim()));
}

function matchesSelector(el, selector) {
  if (selector === "form" || selector === "fieldset") return el.tagName.toLowerCase() === selector;
  if (selector === "[data-luxe-question]") return el.getAttribute("data-luxe-question") !== null;
  if (selector === "[contenteditable]:not([contenteditable='false'])") {
    const value = el.getAttribute("contenteditable");
    return value !== null && value !== "false";
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName.toLowerCase() === selector.toLowerCase();
  return false;
}

test("isNativeInteractiveControl leaves details body descendants annotatable", () => {
  const summaryChild = node("span");
  const summary = node("summary", {}, [summaryChild]);
  const bodyText = node("span");
  const bodyLink = node("a", { href: "#target" });
  const body = node("div", {}, [bodyText, bodyLink]);
  const details = node("details", { open: "" }, [summary, body]);

  assert.equal(isNativeInteractiveControl(summaryChild), true);
  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(bodyText), false);
  assert.equal(isNativeInteractiveControl(bodyLink), false);
});

test("isNativeInteractiveControl allows details as a text selection ancestor", () => {
  const firstParagraph = node("p");
  const secondParagraph = node("p");
  const details = node("details", { open: "" }, [node("summary", {}, [node("span")]), firstParagraph, secondParagraph]);

  assert.equal(isNativeInteractiveControl(details), false);
  assert.equal(isNativeInteractiveControl(firstParagraph), false);
  assert.equal(isNativeInteractiveControl(secondParagraph), false);
});

test("annotation card dismissal closes an empty card and preserves typed text", () => {
  assert.equal(annotationCardCanDismiss(true, ""), true);
  assert.equal(annotationCardCanDismiss(true, "   "), true);
  assert.equal(annotationCardCanDismiss(true, "Keep this draft"), false);
  assert.equal(annotationCardCanDismiss(false, ""), false);
});

test("deriveLuxeQueueKey uses explicit queueKey first", () => {
  const input = node("input", { type: "radio", name: "plan" });

  assert.equal(deriveLuxeQueueKey(input, { queueKey: "deployment-plan" }), "deployment-plan");
});

test("deriveLuxeQueueKey allows explicit empty queueKey to suppress derivation", () => {
  const button = node("button");
  node("section", { "data-luxe-question": "deployment-plan" }, [button]);

  assert.equal(deriveLuxeQueueKey(button, { queueKey: "" }), "");
});

test("deriveLuxeQueueKey groups controls inside data-luxe-question", () => {
  const first = node("button");
  const second = node("button");
  node("section", { "data-luxe-question": "deployment-plan" }, [first, second]);

  assert.equal(deriveLuxeQueueKey(first), "question:deployment-plan");
  assert.equal(deriveLuxeQueueKey(second), "question:deployment-plan");
});

test("deriveLuxeQueueKey groups radio options by scoped group name", () => {
  const planA = node("input", { id: "plan-a", type: "radio", name: "plan", value: "A" });
  const planB = node("input", { id: "plan-b", type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy" }, [planA, planB]);

  assert.equal(deriveLuxeQueueKey(planA), "radio:form:deploy:plan");
  assert.equal(deriveLuxeQueueKey(planB), "radio:form:deploy:plan");
});

test("deriveLuxeQueueKey keeps same radio names independent across scopes", () => {
  const first = node("input", { type: "radio", name: "plan", value: "A" });
  const second = node("input", { type: "radio", name: "plan", value: "B" });
  node("form", { id: "deploy-one" }, [first]);
  node("form", { id: "deploy-two" }, [second]);

  assert.notEqual(deriveLuxeQueueKey(first), deriveLuxeQueueKey(second));
});

test("deriveLuxeQueueKey does not infer plain button grouping without question metadata", () => {
  const button = node("button");

  assert.equal(deriveLuxeQueueKey(button), "");
});

test("deriveLuxeQueueKey keys checkbox toggles per checkbox, not per group", () => {
  const first = node("input", { type: "checkbox", name: "feature", value: "search" });
  const second = node("input", { type: "checkbox", name: "feature", value: "billing" });
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLuxeQueueKey(first), deriveLuxeQueueKey(second));
});

test("deriveLuxeQueueKey does not collide checkbox default values", () => {
  const first = node("input", { id: "search", type: "checkbox", name: "feature" });
  const second = node("input", { id: "billing", type: "checkbox", name: "feature" });
  first.value = "on";
  second.value = "on";
  node("form", { id: "features" }, [first, second]);

  assert.notEqual(deriveLuxeQueueKey(first), deriveLuxeQueueKey(second));
});

test("deriveLuxeQueueKey keys named selects as fields", () => {
  const select = node("select", { name: "region" });
  node("form", { id: "deploy" }, [select]);

  assert.equal(deriveLuxeQueueKey(select), "field:form:deploy:region");
});

test("classifySevereTextOverflow ignores font ink that stays within the rendered line box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 400, top: 0, bottom: 68, width: 400, height: 68 }],
    box: { left: 0, right: 400, top: 0, bottom: 68 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores tiny text-box excursions", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 300, top: 0, bottom: 70, width: 300, height: 70 }],
    box: { left: 0, right: 300, top: 0, bottom: 68 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores centered display glyph ink outside a visible line box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 600, top: -37, bottom: 203, width: 600, height: 240 }],
    box: { left: 0, right: 600, top: 0, bottom: 166 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores a partial vertical line excursion whose center remains visible", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 280, top: 0, bottom: 20, width: 280, height: 20 }],
    box: { left: 0, right: 300, top: 0, bottom: 14 },
    overflowX: "hidden",
    overflowY: "hidden",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow reports a complete line clipped below a fixed box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [
      { left: 0, right: 280, top: 0, bottom: 20, width: 280, height: 20 },
      { left: 0, right: 250, top: 24, bottom: 44, width: 250, height: 20 },
    ],
    box: { left: 0, right: 300, top: 0, bottom: 22 },
    overflowX: "hidden",
    overflowY: "hidden",
  });

  assert.deepEqual(finding, { axis: "vertical", kind: "clipped-text", overflowPx: 22 });
});

test("classifySevereTextOverflow reports a wrapped label spilling beyond its visible box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [
      { left: 4, right: 56, top: 2, bottom: 18, width: 52, height: 16 },
      { left: 4, right: 54, top: 20, bottom: 36, width: 50, height: 16 },
    ],
    box: { left: 0, right: 62, top: 0, bottom: 24 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.deepEqual(finding, { axis: "vertical", kind: "clipped-text", overflowPx: 12 });
});

test("classifySevereTextOverflow suppresses explicit truncation and visually hidden accessibility text", () => {
  const base = {
    fragments: [{ left: 0, right: 300, top: 0, bottom: 20, width: 300, height: 20 }],
    box: { left: 0, right: 120, top: 0, bottom: 20 },
    overflowX: "hidden",
    overflowY: "hidden",
  };

  assert.equal(classifySevereTextOverflow({ ...base, isTruncated: true }), null);
  assert.equal(classifySevereTextOverflow({ ...base, isVisuallyHidden: true }), null);
});

test("classifyMaterialRectEscape detects both clipped starts and ends", () => {
  assert.deepEqual(
    classifyMaterialRectEscape({
      rect: { left: -30, right: 70, top: 0, bottom: 40, width: 100, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
      axes: ["horizontal"],
    }),
    { axis: "horizontal", side: "start", overflowPx: 30 },
  );
  assert.deepEqual(
    classifyMaterialRectEscape({
      rect: { left: 350, right: 430, top: 0, bottom: 40, width: 80, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
      axes: ["horizontal"],
    }),
    { axis: "horizontal", side: "end", overflowPx: 40 },
  );
});

test("classifyMaterialRectEscape suppresses tiny boundary excursions", () => {
  assert.equal(
    classifyMaterialRectEscape({
      rect: { left: -2, right: 98, top: 0, bottom: 40, width: 100, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
    }),
    null,
  );
});

test("isMaterialPageOverflow requires a material escape containing meaningful content", () => {
  assert.equal(isMaterialPageOverflow({ overflowPx: 5, viewportWidth: 390, hasEscapedContent: true }), false);
  assert.equal(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: false }), false);
  assert.equal(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: true }), true);
});

test("findStableLayoutFindings keeps only severe roots present in both samples", () => {
  const first = [
    { selector: "html", kind: "page-horizontal-overflow", axis: "horizontal", severity: "error" },
    { selector: ".moving", kind: "clipped-text", axis: "horizontal", severity: "error" },
  ];
  const second = [
    { selector: "html", kind: "page-horizontal-overflow", axis: "horizontal", severity: "error" },
    { selector: ".late", kind: "clipped-text", axis: "vertical", severity: "error" },
  ];

  assert.deepEqual(findStableLayoutFindings(first, second), [second[0]]);
});

test("isNearTotalOcclusion requires enough samples and at least ninety percent coverage", () => {
  assert.equal(isNearTotalOcclusion({ occludedSamples: 9, totalSamples: 10 }), true);
  assert.equal(isNearTotalOcclusion({ occludedSamples: 8, totalSamples: 10 }), false);
  assert.equal(isNearTotalOcclusion({ occludedSamples: 4, totalSamples: 4 }), false);
});

test("isModeToggleHotkeyEvent matches Cmd/Ctrl+I regardless of case", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "I", ctrlKey: true }), true);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, ctrlKey: true }), true);
});

test("isModeToggleHotkeyEvent requires a modifier so plain typing is unaffected", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i" }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", shiftKey: true }), false);
});

test("isModeToggleHotkeyEvent rejects extra shift or alt modifiers", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "i", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "i", metaKey: true, altKey: true }), false);
});

test("isModeToggleHotkeyEvent ignores other keys even with a modifier held", () => {
  assert.equal(isModeToggleHotkeyEvent({ key: "e", metaKey: true }), false);
  assert.equal(isModeToggleHotkeyEvent({ key: "Enter", metaKey: true }), false);
});

// ---------------------------------------------------------------------------
// Fullscreen-first diagrams. The SDK no longer embeds an editor per diagram; it
// leaves the rendered Mermaid alone and adds one affordance that ASKS the chrome
// for an editor. These are source contracts rather than DOM behaviour, because
// the affordance's behaviour is exercised end to end in a real browser - but
// each of them is a regression that would otherwise land silently.
// ---------------------------------------------------------------------------
const sdkSource = await readFile(new URL("../src/artifact-sdk.js", import.meta.url), "utf8");

test("the SDK selector generator stays inside the server grammar for hostile valid tag names", () => {
  const parent = node("main", { id: "content" });
  const invalidTag = node("foo_bar");
  invalidTag.parentElement = parent;
  parent.children = [invalidTag];
  const longTag = node(`x-${"a".repeat(600)}`);
  longTag.parentElement = parent;
  parent.children.push(longTag);
  const cappedTagName = `x${"a".repeat(509)}`;
  const cappedWithId = node(cappedTagName, { id: "safe" });
  cappedWithId.parentElement = parent;
  parent.children.push(cappedWithId);
  const cappedSibling = node(cappedTagName);
  cappedSibling.parentElement = parent;
  parent.children.push(cappedSibling);

  assert.equal(buildStructuralSelector(invalidTag), "main#content");
  assert.equal(buildStructuralSelector(longTag), "main#content");
  assert.equal(buildStructuralSelector(cappedWithId), cappedTagName);
  assert.equal(buildStructuralSelector(cappedSibling), cappedTagName);
  assert.equal(buildStructuralSelector(node("article", { id: "safe_id" })), "article#safe_id");
  assert.match(sdkSource, /siblingIndex <= 999999/);
});

test("the SDK embeds no whiteboard editor and hides no diagram", () => {
  assert.doesNotMatch(sdkSource, /whiteboard-frame\?/, "the SDK still builds a whiteboard frame URL");
  assert.doesNotMatch(sdkSource, /whiteboard-inline/, "the SDK still embeds an inline whiteboard");
  assert.doesNotMatch(sdkSource, /container\.style\.display = "none"/, "the SDK still hides the Mermaid container");
  assert.doesNotMatch(sdkSource, /luxe:suspendWhiteboard|luxe:resumeWhiteboard/);
});

test("the affordance asks the chrome to open a whiteboard, and carries only an index", () => {
  assert.match(sdkSource, /parent\.postMessage\(\{ type: "luxe:openWhiteboard", diagramIndex: entry\.index \}, "\*"\)/);
  assert.match(sdkSource, /setAttribute\("data-luxe-ui", "whiteboard-edit"\)/);
});

test("the affordance steps aside for annotation and for the diagram it already opened", () => {
  assert.match(sdkSource, /entry\.button\.disabled = busy \|\| annotationMode/);
  assert.match(sdkSource, /luxe:whiteboardOpened/);
  assert.match(sdkSource, /luxe:whiteboardClosed/);
});

test("the affordance reads its colours from the tokens, never from literals", () => {
  // The same rule the rest of the SDK follows: hex belongs in luxe-tokens.css.
  assert.deepEqual(sdkSource.match(/#[0-9a-fA-F]{3,8}\b/g), null);
  for (const name of [
    "radius-nav",
    "stroke-hair",
    "strong",
    "hair",
    "ink-2",
    "ink-3",
    "dark-fill",
    "dark-fill-text",
    "font-sans",
    "text-label",
    "focus-ring",
    "focus-ring-width",
    "focus-ring-offset",
  ]) {
    assert.match(sdkSource, new RegExp(`luxeToken\\("${name}"`), `the affordance hardcodes ${name}`);
  }
});

// ---- The contrast the toolbar's design depends on ---------------------------
//
// These are the assertions that matter, and they are the ones that were missing.
// A first pass at quieting this toolbar chose --surface-1 as the hover fill; it
// measured 1.04:1 against --canvas and 1.00:1 against --surface-1 itself, so the
// "lit" state was invisible and the ghost controls had no affordance at all. Every
// source-text assertion in this file passed on that build, because a regex matching
// a style string cannot tell you whether a human can see the result.
//
// So the colour decisions are checked as colour, against the real token values, in
// plain Node. This runs in `npm run check`; the browser E2E does not.

// `token` and `wcagContrast` come from test/helpers/design-tokens.js rather than being
// restated here: a second copy of the maths is the drift that helper exists to prevent.
//
// The surfaces a diagram can actually sit on. A control inside a Mermaid container
// is over one of these, and the toolbar has no way to know which.
const RESTING_SURFACES = ["canvas", "surface-1", "surface-2"];

test("the toolbar's lit state is a change a person can see, on every surface", async () => {
  // WCAG 1.4.11's 3:1 floor for a non-text state change. The point of the number is
  // that it rules out every surface token in this palette, which is why the lit state
  // is --dark-fill and not a tint.
  const lit = await token("dark-fill");
  for (const name of RESTING_SURFACES) {
    const ratio = wcagContrast(lit, await token(name));
    assert.ok(ratio >= 3, `the hover/focus fill is ${ratio.toFixed(2)}:1 against --${name}, which nobody can see`);
  }
  assert.match(sdkSource, /--luxe-diagram-btn-bg:" \+\s*luxeToken\("dark-fill"/, "the lit fill is not --dark-fill");
});

test("the lit control's own glyph stays readable on the lit fill", async () => {
  const ratio = wcagContrast(await token("dark-fill-text"), await token("dark-fill"));
  assert.ok(ratio >= 4.5, `the hovered glyph is ${ratio.toFixed(2)}:1 on its own fill`);
});

test("the resting glyph and the disabled glyph are both legible", async () => {
  // The resting ink carries the control on its own now that nothing is filled.
  for (const name of RESTING_SURFACES) {
    const rest = wcagContrast(await token("ink-2"), await token(name));
    assert.ok(rest >= 4.5, `the resting glyph is ${rest.toFixed(2)}:1 against --${name}`);
  }
  // Disabled is not exempt: the control disabled on page load is the zoom percentage,
  // and a percentage is information whether or not pressing it does anything. The
  // treatment this replaced composited --ink-2 at opacity .45 down to 2.04:1.
  for (const name of RESTING_SURFACES) {
    const dim = wcagContrast(await token("ink-3"), await token(name));
    assert.ok(dim >= 3, `the disabled glyph is ${dim.toFixed(2)}:1 against --${name}`);
  }
  assert.doesNotMatch(
    sdkSource,
    /style\.opacity = enabled/,
    "disabled is an opacity again, which fades the border too",
  );
  assert.match(sdkSource, /--luxe-diagram-btn-ink", luxeToken\("ink-3"/);
});

test("the readout never dims, because its value is the reason it is disabled", () => {
  // "100%" is both the state and the explanation for why resetting is a no-op.
  assert.match(sdkSource, /readoutControls\.add\(reset\)/);
  assert.match(sdkSource, /enabled \|\| readoutControls\.has\(button\)/);
  // Still genuinely disabled, though - the clamp must not silently no-op.
  assert.match(sdkSource, /reset\.disabled = percent === 100/);
});

test("the zoom controls are one segmented object, not three loose buttons", () => {
  // The complaint was that the controls outweighed the diagram. Halving the object
  // count is what buys the boundary back without buying four pills back with it.
  assert.match(sdkSource, /group\.append\(zoomOut, reset, zoomIn\)/);
  assert.match(sdkSource, /setAttribute\("role", "group"\)/);
  assert.match(sdkSource, /setAttribute\("aria-label", "Diagram zoom"\)/);
  assert.match(sdkSource, /border-left:/, "the segments have no dividers");
  assert.doesNotMatch(sdkSource, /overflow:hidden;.*border-radius/, "clipping the group would clip the focus ring");
});

test("the strip aligns to the diagram's edge, not the container's", () => {
  // flex-end against the container only looks right when the SVG fills it; under a
  // narrow diagram it puts the controls beside the thing they control.
  assert.match(sdkSource, /function alignBarToDiagram/);
  assert.match(sdkSource, /contentRight - svgRect\.right/);
  assert.match(sdkSource, /svgRect\.left - contentLeft/);
  // Which edge it hugs depends on whether the strip can fit under the diagram at all.
  // Squeezing it into a column narrower than itself is what made it wrap and spill.
  assert.match(sdkSource, /barNaturalWidth\(bar\) <= svgRect\.width \+ 1/);
  // The container is observed, and its height moves when the strip rewraps, so an
  // unconditional write would be a resize feedback loop.
  assert.match(sdkSource, /if \(bar\.style\[property\] !== value\) bar\.style\[property\] = value/);
  assert.match(sdkSource, /new ResizeObserver\(\(\) => alignBarToDiagram\(entry\)\)/);
});

test("the toolbar repairs the artifact rather than imposing on it", () => {
  assert.match(sdkSource, /:hover:not\(:disabled\)/, "a disabled control can light up as if it were live");
  assert.match(sdkSource, /outline-offset:/, "the focus ring lost its offset");
  // Spacing is taste, so it stays at zero specificity and any author rule beats it.
  assert.match(sdkSource, /":where\(" \+\s*enhancedDiagram \+\s*"\)\{padding:20px 16px\}"/);
  // The emitted CSS, not the prose around it - the comments in there discuss `!important`
  // precisely because the rules must not use it.
  const toolbarCss = sdkSource
    .slice(sdkSource.indexOf("function injectDiagramToolbarCss"), sdkSource.indexOf("function makeToolbarButton"))
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(toolbarCss.length > 0);
  assert.match(toolbarCss, /background:transparent/, "the slice no longer covers the emitted rules");
  assert.doesNotMatch(toolbarCss, /!important/);
});

// ---- The code-block frame around a picture ----------------------------------
//
// A Mermaid diagram is usually a <pre>, and every code-block stylesheet ends in a
// bare `pre { background; border; border-radius }` - Luxe's own theme snippet did.
// So every artifact authored before this drew its diagrams inside a code block's
// frame. Nobody noticed while the fill sat ~2 units off the canvas; adding padding
// inside that frame inflated it by 40px and made it plain.
//
// The repair is only a repair if it actually wins the cascade, and `:where()` -
// which is what the padding correctly uses - is zero specificity and loses to a
// bare element selector. That is the trap this test exists for.

/** CSS specificity of a selector, as [id, class, element]. */
function specificity(selector) {
  // `:where()` contributes nothing, contents included. That is the entire reason it is
  // wrong for the reset and right for the padding, so the model has to know it.
  const counted = selector.replace(/:where\([^()]*(\([^()]*\))?[^()]*\)/g, " ");
  const ids = counted.match(/#[\w-]+/g)?.length ?? 0;
  // Classes, attribute selectors and pseudo-classes all weigh the same.
  const classes = counted.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!\()/g)?.length ?? 0;
  const elements = counted.match(/(^|[\s>+~])[a-z][\w-]*/g)?.length ?? 0;
  return [ids, classes, elements];
}

function outweighs(a, b) {
  const [x, y] = [specificity(a), specificity(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

test("the diagram's code-block frame is reset, and the reset outweighs a bare `pre` rule", () => {
  // The selector the SDK builds, reconstructed from its own parts rather than restated.
  const attribute = /const diagramContainerAttribute = "([^"]+)"/.exec(sdkSource)?.[1];
  assert.equal(attribute, "data-luxe-diagram", "the diagram marker attribute moved");
  const selector = `.mermaid[${attribute}]`;
  assert.ok(
    sdkSource.includes(`".mermaid[" + diagramContainerAttribute + "]"`),
    "the reset selector is no longer built from .mermaid plus the marker attribute",
  );

  // The whole point: it has to beat `pre`, and `:where()` would not.
  assert.ok(outweighs(selector, "pre"), `${selector} does not outweigh a bare pre rule`);
  assert.ok(outweighs(selector, ".mockup-code"), `${selector} does not outweigh a single-class rule`);
  assert.deepEqual(specificity(`:where(${selector})`), [0, 0, 0], "the specificity model is wrong about :where()");

  // And it must not be wrapped in :where(), which is the mistake that would silently
  // reintroduce the frame while still looking like a fix in the diff.
  assert.match(
    sdkSource,
    /enhancedDiagram \+\s*"\{background:transparent;border:0;border-radius:0;box-shadow:none\}"/,
    "the code-block reset is missing or has been weakened",
  );

  // An author who wants a framed diagram must still be able to win. Two classes plus
  // anything at all outweighs the reset, with no !important involved.
  assert.ok(outweighs(`.mermaid.mermaid[${attribute}]`, selector), "an author can no longer override the reset");
  assert.ok(outweighs(`#article .mermaid[${attribute}]`, selector), "an id selector can no longer override the reset");
});

test("the code-block reset only touches diagrams Luxe actually rendered", () => {
  // A .mermaid whose source never rendered IS showing source, and the code-block
  // framing describes it correctly. The marker goes on only after the SVG has laid out.
  const enhance = sdkSource.slice(
    sdkSource.indexOf("function addWhiteboardAffordance"),
    sdkSource.indexOf("// Align the strip"),
  );
  assert.ok(enhance.length > 0);
  const guard = enhance.indexOf("getBoundingClientRect().height < 40");
  const marker = enhance.indexOf("container.setAttribute(diagramContainerAttribute");
  assert.ok(guard > 0 && marker > guard, "the marker is set before the diagram is known to have rendered");
  // It is content, not chrome: the agent must still see the diagram in the snapshot.
  assert.doesNotMatch(
    sdkSource,
    /setAttribute\("data-luxe-ui", "diagram"\)/,
    "the diagram container was marked as Luxe UI, which would hide it from the agent",
  );
});
