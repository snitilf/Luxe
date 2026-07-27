/* global Element, MutationObserver, ResizeObserver, document, getComputedStyle, parent, window */

import * as mermaidHelpers from "./mermaid-node.js";

export const LUXE_INTERNAL_QUEUE_KEY = "_luxeQueueKey";

export const MODE_TOGGLE_HOTKEY_KEY = "i";
export const DOM_SNAPSHOT_MAX_NODES = 2_000;
export const DOM_SNAPSHOT_MAX_BYTES = 128 * 1024;
export const DOM_SNAPSHOT_TRUNCATION_MARKER = "[Luxe DOM snapshot truncated]";

export function annotationCardCanDismiss(cardOpen, draftValue) {
  return Boolean(cardOpen) && !String(draftValue || "").trim();
}

/**
 * @param {unknown} root
 * @param {object} options
 * @param {(element: unknown) => boolean} options.isElement
 * @param {(element: unknown) => { includeSelf: boolean, traverseChildren: boolean }} options.visibility
 * @param {(element: unknown) => boolean} options.isExcluded
 * @param {(element: unknown) => { uid?: unknown, tag?: unknown, text?: unknown }} options.describe
 * @param {(element: unknown) => Iterable<unknown>} [options.childrenOf]
 * @param {number} [options.maxNodes]
 * @param {number} [options.maxBytes]
 * @param {(value: string) => number} [options.byteLength]
 */
export function buildDomSnapshot(
  root,
  {
    isElement,
    visibility,
    isExcluded,
    describe,
    childrenOf = (element) =>
      element && typeof element === "object" && "children" in element && element.children
        ? /** @type {Iterable<unknown>} */ (element.children)
        : [],
    maxNodes = DOM_SNAPSHOT_MAX_NODES,
    maxBytes = DOM_SNAPSHOT_MAX_BYTES,
    byteLength = (value) => new TextEncoder().encode(value).byteLength,
  },
) {
  const lines = [];
  const markerBytes = byteLength(DOM_SNAPSHOT_TRUNCATION_MARKER);
  const byteLimit = Math.max(markerBytes, Number(maxBytes) || 0);
  const nodeLimit = Math.max(1, Number(maxNodes) || 0);
  let bytes = 0;
  let nodes = 0;
  let truncated = false;

  function append(line) {
    const prefix = lines.length ? "\n" : "";
    const additionBytes = byteLength(prefix + line);
    if (bytes + additionBytes > byteLimit) {
      truncated = true;
      return false;
    }
    lines.push(line);
    bytes += additionBytes;
    return true;
  }

  /** @type {Array<{ element: unknown, depth: number } | { iterator: Iterator<unknown>, depth: number }>} */
  const stack = [{ element: root, depth: 0 }];
  while (stack.length > 0 && !truncated) {
    const frame = stack.pop();
    if (!frame) break;
    if ("iterator" in frame) {
      const next = frame.iterator.next();
      if (!next.done) {
        stack.push(frame);
        stack.push({ element: next.value, depth: frame.depth });
      }
      continue;
    }

    const { element, depth } = frame;
    if (!isElement(element)) continue;
    if (nodes >= nodeLimit) {
      truncated = true;
      break;
    }
    nodes += 1;
    if (isExcluded(element)) continue;

    const decision = visibility(element);
    if (decision.includeSelf) {
      const description = describe(element) || {};
      const text = String(description.text || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80)
        .replace(/"/g, "'");
      const suffix = text ? ` "${text}"` : "";
      if (
        !append(`${"  ".repeat(depth)}uid=${String(description.uid || "")} ${String(description.tag || "")}${suffix}`)
      ) {
        break;
      }
    }

    if (decision.traverseChildren) {
      stack.push({ iterator: childrenOf(element)[Symbol.iterator](), depth: depth + 1 });
    }
  }

  if (truncated) {
    while (lines.length > 0) {
      const snapshot = lines.join("\n");
      if (byteLength(`${snapshot}\n${DOM_SNAPSHOT_TRUNCATION_MARKER}`) <= byteLimit) break;
      lines.pop();
    }
    lines.push(DOM_SNAPSHOT_TRUNCATION_MARKER);
  }

  return lines.join("\n");
}

export function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

// Derive the browser-only replacement key used to collapse unsent updates for the same input.
// The key is stripped by the chrome before prompts are sent to the server or returned by poll.
export function deriveLuxeQueueKey(element, options = {}) {
  function stringValue(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function attributeValue(el, name) {
    if (!el) return "";
    if (el.getAttribute) {
      const value = el.getAttribute(name);
      if (value !== null && value !== undefined) return value;
    }
    return el[name] || "";
  }

  function tagName(el) {
    return stringValue(el?.tagName || el?.nodeName).toLowerCase();
  }

  function closestElementMatching(el, selector) {
    return el && el.closest ? el.closest(selector) : null;
  }

  function elementPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = tagName(node) || "element";
      const id = stringValue(attributeValue(node, "id") || node.id).trim();
      if (id) {
        part += `#${id}`;
        parts.unshift(part);
        break;
      }

      const parent = node.parentElement;
      if (parent && parent.children) {
        const siblings = [...parent.children].filter((child) => tagName(child) === tagName(node));
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function scopeKey(el) {
    const scope = closestElementMatching(el, "form,fieldset") || el?.parentElement || el;
    const tag = tagName(scope) || "scope";
    const explicit = stringValue(
      attributeValue(scope, "data-luxe-question") || attributeValue(scope, "id") || attributeValue(scope, "name"),
    ).trim();
    if (explicit) return `${tag}:${explicit}`;
    return elementPath(scope) || tag;
  }

  function controlIdentity(el) {
    const identity = stringValue(attributeValue(el, "name") || attributeValue(el, "id") || el?.name).trim();
    if (identity) return identity;
    return elementPath(el);
  }

  function isKeyedInputType(type) {
    return !new Set(["button", "submit", "reset", "file", "image", "hidden", "radio", "checkbox"]).has(type);
  }

  if (Object.hasOwn(options, "queueKey")) {
    return stringValue(options.queueKey).trim();
  }

  const question = closestElementMatching(element, "[data-luxe-question]");
  const questionKey = stringValue(attributeValue(question, "data-luxe-question")).trim();
  if (questionKey) return `question:${questionKey}`;

  const tag = tagName(element);
  const type = stringValue(attributeValue(element, "type") || element?.type).toLowerCase();
  const scope = scopeKey(element);

  if (tag === "input" && type === "radio") {
    const name = stringValue(attributeValue(element, "name") || element?.name).trim();
    if (name) return `radio:${scope}:${name}`;
    return "";
  }

  if (tag === "input" && type === "checkbox") {
    const identity = controlIdentity(element);
    const explicitValue = stringValue(element?.getAttribute ? element.getAttribute("value") : "").trim();
    const option = explicitValue || stringValue(attributeValue(element, "id") || elementPath(element)).trim();
    if (identity) return `checkbox:${scope}:${identity}:${option}`;
    return "";
  }

  if (tag === "select" || tag === "textarea" || (tag === "input" && isKeyedInputType(type))) {
    const identity = controlIdentity(element);
    if (identity) return `field:${scope}:${identity}`;
  }

  return "";
}

export function isNativeInteractiveControl(el) {
  return !!(
    el &&
    el.closest &&
    el.closest(
      "button,input,select,textarea,option,optgroup,label,summary,[contenteditable]:not([contenteditable='false'])",
    )
  );
}

// A severe text failure needs rendered-fragment proof. Scroll dimensions include harmless font
// ink, masks, transforms, and offscreen carousel content, so they are never sufficient. A line is
// severe only when a material portion of a real text fragment crosses its own clipping boundary,
// or a wrapped line spills substantially outside its own visible box. Explicit truncation and
// standard accessibility hiding are author intent and stay silent.
export function classifySevereTextOverflow({
  fragments,
  box,
  overflowX,
  overflowY,
  isTruncated = false,
  isVisuallyHidden = false,
  minOutsideRatio = 0.2,
  epsilon = 1,
}) {
  function overflowOf(fragment, boundary, axis) {
    const start = Number(axis === "horizontal" ? fragment.left : fragment.top);
    const end = Number(axis === "horizontal" ? fragment.right : fragment.bottom);
    const boxStart = Number(axis === "horizontal" ? boundary.left : boundary.top);
    const boxEnd = Number(axis === "horizontal" ? boundary.right : boundary.bottom);
    const explicitSize = Number(axis === "horizontal" ? fragment.width : fragment.height);
    const size = Number.isFinite(explicitSize) ? Math.max(0, explicitSize) : Math.max(0, end - start);
    if (![start, end, boxStart, boxEnd, size].every(Number.isFinite) || size <= 0) {
      return { overflowPx: 0, outsideRatio: 0, centerOutside: false };
    }
    const before = Math.max(0, boxStart - start);
    const after = Math.max(0, end - boxEnd);
    const center = start + size / 2;
    return {
      overflowPx: Math.max(before, after),
      outsideRatio: Math.min(1, (before + after) / size),
      centerOutside: center < boxStart || center > boxEnd,
    };
  }

  if (isTruncated || isVisuallyHidden || !box || !Array.isArray(fragments) || fragments.length === 0) return null;

  const clipsX = overflowX === "hidden" || overflowX === "clip";
  const clipsY = overflowY === "hidden" || overflowY === "clip";
  const spillsY = overflowY === "visible";
  const scrollsX = overflowX === "auto" || overflowX === "scroll";
  const scrollsY = overflowY === "auto" || overflowY === "scroll";
  let strongest = null;

  for (const fragment of fragments) {
    const horizontal = overflowOf(fragment, box, "horizontal");
    const vertical = overflowOf(fragment, box, "vertical");
    const severeX =
      clipsX &&
      !scrollsX &&
      horizontal.overflowPx > epsilon &&
      (horizontal.centerOutside || horizontal.outsideRatio >= minOutsideRatio);
    const severeY = (clipsY || spillsY) && !scrollsY && vertical.overflowPx > epsilon && vertical.centerOutside;
    const candidates = [
      severeX ? { axis: "horizontal", kind: "clipped-text", overflowPx: horizontal.overflowPx } : null,
      severeY ? { axis: "vertical", kind: "clipped-text", overflowPx: vertical.overflowPx } : null,
    ];
    for (const candidate of candidates) {
      if (candidate && (!strongest || candidate.overflowPx > strongest.overflowPx)) strongest = candidate;
    }
  }

  return strongest;
}

export function classifyMaterialRectEscape({
  rect,
  boundary,
  axes = ["horizontal", "vertical"],
  minOutsidePx = 4,
  minOutsideRatio = 0.2,
}) {
  let strongest = null;
  for (const axis of axes) {
    const start = Number(axis === "horizontal" ? rect?.left : rect?.top);
    const end = Number(axis === "horizontal" ? rect?.right : rect?.bottom);
    const boundaryStart = Number(axis === "horizontal" ? boundary?.left : boundary?.top);
    const boundaryEnd = Number(axis === "horizontal" ? boundary?.right : boundary?.bottom);
    const explicitSize = Number(axis === "horizontal" ? rect?.width : rect?.height);
    const size = Number.isFinite(explicitSize) ? Math.max(0, explicitSize) : Math.max(0, end - start);
    if (![start, end, boundaryStart, boundaryEnd, size].every(Number.isFinite) || size <= 0) continue;
    const before = Math.max(0, boundaryStart - start);
    const after = Math.max(0, end - boundaryEnd);
    const outsidePx = Math.max(before, after);
    const outsideRatio = Math.min(1, (before + after) / size);
    const center = start + size / 2;
    const centerOutside = center < boundaryStart || center > boundaryEnd;
    if (outsidePx < minOutsidePx || (!centerOutside && outsideRatio < minOutsideRatio)) continue;
    const candidate = {
      axis,
      side: before >= after ? "start" : "end",
      overflowPx: outsidePx,
    };
    if (!strongest || candidate.overflowPx > strongest.overflowPx) strongest = candidate;
  }
  return strongest;
}

// Tiny document deltas are cosmetic. A page failure becomes reportable only when meaningful
// content materially escapes the usable viewport; callers establish that content evidence from
// actual visible element bounds.
export function isMaterialPageOverflow({ overflowPx, viewportWidth, hasEscapedContent }) {
  const overflow = Number(overflowPx);
  const width = Number(viewportWidth);
  const materialThreshold = Math.max(24, Number.isFinite(width) ? width * 0.05 : 24);
  return Boolean(hasEscapedContent) && Number.isFinite(overflow) && overflow >= materialThreshold;
}

export function findStableLayoutFindings(first, second) {
  const key = (finding) => `${finding.kind}:${finding.selector}:${finding.axis || ""}`;
  const firstKeys = new Set(
    (Array.isArray(first) ? first : []).filter((finding) => finding?.severity === "error").map(key),
  );
  return (Array.isArray(second) ? second : []).filter(
    (finding) => finding?.severity === "error" && firstKeys.has(key(finding)),
  );
}

export function isNearTotalOcclusion({ occludedSamples, totalSamples, minSamples = 5, minRatio = 0.9 }) {
  const occluded = Number(occludedSamples);
  const total = Number(totalSamples);
  return Number.isFinite(occluded) && Number.isFinite(total) && total >= minSamples && occluded / total >= minRatio;
}

export function buildStructuralSelector(element) {
  let leaf = element;
  while (leaf && leaf.nodeType === 1) {
    const leafTag = String(leaf.tagName || "").toLowerCase();
    if (/^[a-z][a-z0-9-]*$/.test(leafTag) && leafTag.length <= 512) break;
    leaf = leaf.parentElement;
  }
  if (!leaf || leaf.nodeType !== 1) return "";

  const parts = [];
  let node = leaf;
  while (node && node.nodeType === 1 && parts.length < 5) {
    const tag = String(node.tagName || "").toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) break;
    let part = tag;
    const safeId = String(node.id || "");
    if (/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(safeId)) {
      const idPart = part + "#" + safeId;
      if (idPart.length <= 512) {
        parts.unshift(idPart);
        break;
      }
    }

    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((candidate) => candidate.tagName === node.tagName);
      const siblingIndex = same.indexOf(node) + 1;
      if (same.length > 1 && siblingIndex > 0 && siblingIndex <= 999999) {
        const indexedPart = part + ":nth-of-type(" + siblingIndex + ")";
        if (indexedPart.length <= 512) part = indexedPart;
      }
    }
    parts.unshift(part);
    node = parent;
  }

  while (parts.length > 1 && parts.join(" > ").length > 512) parts.shift();
  return parts.join(" > ");
}

export function createArtifactSdk(
  deriveQueueKey,
  isNativeInteractive = isNativeInteractiveControl,
  mermaid = mermaidHelpers,
  // The Luxe design tokens, passed in as CSS text by createSdkJs. The SDK carries
  // no colour of its own: src/luxe-tokens.css is the only place hex literals live,
  // and this is how the annotation surface gets them into an artifact page whose
  // own stylesheet is none of our business.
  luxeTokensCss = "",
  snapshotBuilder = buildDomSnapshot,
  selectorBuilder = buildStructuralSelector,
  annotationCardDismissPolicy = annotationCardCanDismiss,
  // The artifact baseline, also passed in as CSS text by createSdkJs. See
  // src/artifact-baseline.css for what it is allowed to contain and why it is only
  // ever repairs.
  artifactBaselineCss = "",
  baselineStyleId = "luxe-baseline",
  baselineOptOutAttribute = "data-luxe-baseline",
) {
  const { isMermaidSvg, mermaidNodeFrom, mermaidNodeElement } = mermaid;
  // The SDK has no mode state of its own to decide: the chrome owns annotate/explore and
  // pushes it here via `luxe:setAnnotationMode` on every frame load. This initial value only
  // covers the few milliseconds before that message arrives, so it must match the chrome's
  // default (ANNOTATION_DEFAULT in server.js). Starting it `true` while the chrome starts
  // `false` is not a wrong-mode bug - it is a flash of annotate cursors and frozen diagrams
  // on every load and reload.
  let annotationMode = false;
  // Terminal. Set once by `luxe:setSessionEnded` and never cleared: an ended session cannot
  // become live again without a page load, which rebuilds this module anyway. Kept apart from
  // annotationMode because the chrome used to signal the end by turning annotation off, and
  // "annotation is off" is precisely the condition under which the whiteboard affordance is
  // ENABLED - so the end re-armed the control it meant to retire.
  let sessionEnded = false;
  let hovered = null;
  let selected = null;
  let ignoreNextClick = false;
  let shadow = null;
  let counter = 0;
  let annotationSequence = 0;
  const ids = new WeakMap();

  // Read one token value out of the design-token CSS. Used only where a value has
  // to cross into the artifact's own document, which cannot see the shadow root's
  // custom properties.
  function luxeToken(name, fallback) {
    const match = new RegExp("--" + name + "\\s*:\\s*([^;]+);").exec(luxeTokensCss);
    return match ? match[1].trim() : fallback;
  }

  function uid(el) {
    if (!ids.has(el)) ids.set(el, String(++counter));
    return ids.get(el);
  }

  // A reviewer is annotating a paragraph, not a <p>. The raw tag name was a developer
  // wink that reads, at a glance, like an unrendered template variable - and this string
  // is the title of the most-seen surface in the product. Anything unrecognised keeps the
  // tag, which is still better than nothing for a custom element.
  const FRIENDLY_ELEMENT_NAMES = {
    p: "paragraph",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    li: "list item",
    ul: "list",
    ol: "list",
    table: "table",
    tr: "table row",
    td: "table cell",
    th: "table heading",
    img: "image",
    svg: "graphic",
    figure: "figure",
    figcaption: "caption",
    blockquote: "quote",
    pre: "code block",
    code: "code",
    button: "button",
    a: "link",
    section: "section",
    header: "header",
    footer: "footer",
    form: "form",
    label: "label",
    input: "field",
    textarea: "field",
    select: "field",
  };

  function friendlyElementName(tag) {
    const name = String(tag || "").toLowerCase();
    return FRIENDLY_ELEMENT_NAMES[name] || `&lt;${escapeAnnotationText(name)}&gt;`;
  }

  function escapeAnnotationText(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }

  function selector(el) {
    return selectorBuilder(el);
  }

  function context(el) {
    const base = {
      uid: uid(el),
      selector: selector(el),
      tag: (el.tagName || "").toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240),
    };

    const mermaidNode = mermaidNodeFrom(el, selector);
    if (mermaidNode) {
      base.tag = "mermaid-node";
      base.text = mermaidNode.label || base.text;
      base.target = mermaidNode;
    }

    return base;
  }

  // Hover and click must outline the exact element they annotate. Clicking inside
  // a Mermaid diagram annotates the whole <g> node, so resolve a raw event target
  // up to that node before highlighting; every other element annotates itself.
  function annotationTargetEl(el) {
    return mermaidNodeElement(el) || el;
  }

  // ---------------------------------------------------------------------------
  // Mermaid diagram enhancement: pan/zoom in explore mode, freeze in annotate
  // mode. All of this operates on the rendered SVG only; the saved artifact is
  // never modified, so a diagram still renders identically when opened directly.
  // Node identity/label extraction lives in the injected `mermaid` helpers so it
  // can be unit tested and shared with the server-side target validator.
  // ---------------------------------------------------------------------------

  const mermaidViewports = new WeakMap();

  function findMermaidSvgs() {
    const svgs = new Set();
    for (const svg of document.querySelectorAll("svg")) {
      if (isMermaidSvg(svg)) svgs.add(svg);
    }
    return [...svgs];
  }

  // A minimal, dependency-free viewBox-based pan/zoom. Kept small on purpose:
  // "nodes only" annotation plus freeze-on-annotate means we do not need
  // momentum, gestures, or a full pan/zoom library here. svg-pan-zoom is a
  // documented drop-in upgrade if richer interaction is wanted later.
  function createViewport(svg) {
    const bbox = svg.getBBox ? safeBBox(svg) : null;
    const initial = readViewBox(svg) || (bbox ? { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height } : null);
    if (!initial) return null;
    svg.setAttribute("viewBox", `${initial.x} ${initial.y} ${initial.w} ${initial.h}`);

    const view = { ...initial };
    let frozen = false;
    let panning = null;
    const listeners = new Set();

    // The clamp, named once. A smaller viewBox is a closer view, so MIN_W is maximum
    // zoom in: 40x in, 8x out, which the toolbar reports as 4000% and 12.5% of fit.
    const MIN_W = initial.w / 40;
    const MAX_W = initial.w * 8;

    function notify() {
      for (const listener of listeners) listener();
    }
    function apply() {
      svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
      notify();
    }
    function reset() {
      Object.assign(view, initial);
      apply();
    }
    // Scale relative to fit, so 1 is "the whole diagram" and the toolbar can print a
    // percentage a reader recognises.
    function getScale() {
      return initial.w / view.w;
    }
    function atMinZoom() {
      return view.w >= MAX_W - 1e-9;
    }
    function atMaxZoom() {
      return view.w <= MIN_W + 1e-9;
    }
    function zoomTo(fx, fy, factor) {
      const next = Math.min(Math.max(view.w * factor, MIN_W), MAX_W);
      const scale = next / view.w;
      view.w = next;
      view.h *= scale;
      view.x = fx - (fx - view.x) * scale;
      view.y = fy - (fy - view.y) * scale;
      apply();
    }
    function zoomAt(clientX, clientY, factor) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = (clientX - rect.left) / rect.width;
      const py = (clientY - rect.top) / rect.height;
      zoomTo(view.x + view.w * px, view.y + view.h * py, factor);
    }
    // Button zoom works about the centre of the current view rather than a pointer
    // position, so repeated clicks stay put instead of drifting toward a corner. It is
    // deliberately not gated on `frozen`: freezing exists so a click on a diagram
    // resolves to a node instead of a pan, and an explicit button press is not ambiguous.
    function zoomBy(factor) {
      zoomTo(view.x + view.w / 2, view.y + view.h / 2, factor);
    }

    function onWheel(event) {
      if (frozen) return;
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 1.15 : 1 / 1.15);
    }
    function onPointerDown(event) {
      if (frozen || event.button !== 0) return;
      panning = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture?.(event.pointerId);
      svg.style.cursor = "grabbing";
    }
    function onPointerMove(event) {
      if (!panning) return;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      view.x = panning.vx - ((event.clientX - panning.x) / rect.width) * view.w;
      view.y = panning.vy - ((event.clientY - panning.y) / rect.height) * view.h;
      apply();
    }
    function onPointerUp(event) {
      panning = null;
      svg.releasePointerCapture?.(event.pointerId);
      svg.style.cursor = frozen ? "" : "grab";
    }

    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointercancel", onPointerUp);

    function setFrozen(next) {
      frozen = !!next;
      panning = null;
      svg.style.cursor = frozen ? "" : "grab";
      svg.style.touchAction = frozen ? "" : "none";
    }
    // Derive the viewport's initial freeze from the current mode rather than hardcoding
    // "explore". The caller sets it again immediately, so this never mattered while the
    // default was annotate-on; it is the fourth place the annotate default was written down,
    // and the only one no message ever corrects if a future caller forgets to.
    setFrozen(annotationMode);

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    return { reset, setFrozen, zoomBy, getScale, atMinZoom, atMaxZoom, subscribe };
  }

  function safeBBox(svg) {
    try {
      return svg.getBBox();
    } catch {
      return null;
    }
  }

  function readViewBox(svg) {
    const raw = svg.getAttribute?.("viewBox");
    if (!raw) return null;
    const parts = raw
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  // Diagram toolbar. Luxe is fullscreen-first: the rendered diagram stays exactly what
  // the artifact author wrote - themed Mermaid, visible, selectable, printable, and
  // identical when the file is opened standalone or exported - and gets one quiet strip
  // of controls beneath it.
  //
  // Beneath, not on top of. The edit affordance used to be absolutely positioned at
  // top-right INSIDE the diagram container, so it covered whatever the diagram drew
  // there - which on a wide flowchart is a node. The strip is laid out after the
  // diagram in normal flow and cannot overlap it at any width.
  //
  // The zoom controls exist because the viewport has always supported wheel-zoom and
  // drag-pan with nothing on screen saying so, which left "open the whole whiteboard"
  // as the only discoverable way to look closer.
  //
  // Everything here is `data-luxe-ui`, so the annotation layer and the snapshot walker
  // both skip it; the export reads the artifact from disk and never sees it at all.
  //
  // The index of the container among `.mermaid` elements in document order is
  // the diagram's identity; the server recovers the matching Mermaid source
  // from the artifact file on disk under that same index.
  const whiteboardAffordances = new Map(); // container -> { button, index, bar, viewport, ... }
  let openWhiteboardIndex = null;

  function mermaidContainerIndex(container) {
    return [...document.querySelectorAll(".mermaid")].indexOf(container);
  }

  // A disabled control that does not say why is a dead end. Each reason is also the
  // accessible description, so it reaches a screen reader and not only a hover.
  function affordanceReason(entry) {
    if (sessionEnded) return "This session has ended.";
    if (openWhiteboardIndex === entry.index) return "This diagram is open in the whiteboard.";
    if (annotationMode) return "Turn off Annotate to edit this diagram as a whiteboard.";
    return "Open this diagram as an editable whiteboard";
  }

  function setAffordanceState(entry) {
    const busy = openWhiteboardIndex === entry.index;
    entry.button.disabled = busy || annotationMode || sessionEnded;
    entry.button.textContent = busy ? "Editing in the whiteboard" : "Edit as whiteboard";
    entry.button.setAttribute("aria-disabled", String(entry.button.disabled));
    entry.button.title = affordanceReason(entry);
    // A disabled control has to LOOK disabled. Without this the button kept full opacity
    // and cursor:pointer, so a reviewer with annotate mode on clicked a control that
    // looked entirely live and nothing happened - which reads as a broken feature rather
    // than an unavailable one. The zoom buttons beside it already dim; this is the same
    // treatment, and the reason is on the tooltip either way.
    setControlEnabled(entry.button, !entry.button.disabled);
    entry.updateZoom?.();
  }

  // A readout is not just a control. The zoom percentage is information the reviewer needs
  // whether or not pressing it would do anything, so it never dims - and it does not have to,
  // because the value it displays IS the reason it is disabled: it reads "100%", which is
  // precisely why resetting to fit is a no-op. Everything else in here dims.
  const readoutControls = new WeakSet();

  // One place decides what disabled looks like, so no control in this toolbar can be
  // disabled-but-inviting again.
  //
  // This used to be `opacity: 0.45`, which was fine while every control was a filled,
  // outlined pill - the whole pill faded together. Once the pills came off, that opacity
  // composited --ink-2 down to about 2.04:1 against the surface behind it, and the control
  // that is disabled on page load is the percentage readout. So dimming is a colour now:
  // --ink-3 is the system's de-emphasis ink and lands at 3.43:1, still comfortably readable.
  // Opacity would also have faded the segmented control's dividers and border along with the
  // glyph, dissolving the boundary that makes these read as controls at all.
  function setControlEnabled(button, enabled) {
    button.style.cursor = enabled ? "pointer" : "default";
    // An inline custom property beats the stylesheet's, which is exactly right here: a
    // disabled control must not take the hover ink. The hover rule is gated on
    // `:not(:disabled)` as well, so the two agree rather than race.
    if (enabled || readoutControls.has(button)) button.style.removeProperty("--luxe-diagram-btn-ink");
    else button.style.setProperty("--luxe-diagram-btn-ink", luxeToken("ink-3", "GrayText"));
  }

  function refreshAffordances() {
    for (const entry of whiteboardAffordances.values()) {
      if (entry.button.isConnected) setAffordanceState(entry);
    }
  }

  // Injection 3 of 5 outside the shadow DOM. Like the other two, every colour and metric
  // is read out of the design-token text rather than written as a literal, and every
  // fallback is a keyword rather than a hex so a missing token degrades to the artifact's
  // own palette instead of a foreign one.
  //
  // Four filled, outlined pills under a 64px diagram outweighed the diagram. Stripping every
  // pill fixed the weight and broke the affordance: with no border and no fill, nothing said
  // "control", and no hover fill could say it either - every surface token in this system
  // sits within 1.05:1 of the canvas, so a fill can never BE the affordance here. Measured:
  // --surface-1 against --canvas is 1.04:1, against --surface-2 it is 1.05:1 and darker than
  // the surface, and on --surface-1 itself it is 1.00:1. Invisible in every direction.
  //
  // So the boundary comes back, once instead of four times. The three zoom controls sit in a
  // single hairline-bordered segmented control with --hair dividers between them, and the
  // whiteboard button carries the same hairline. Two quiet objects, not four loud ones, and
  // the object count is what "too big compared to the diagram" was really measuring.
  //
  // The affordance a person can see is the glyph and the fill together, and it only appears
  // on hover and focus: --dark-fill at 10.63:1 against --canvas, with --dark-fill-text on it
  // at 10.63:1. That is the system's own ghost-button pattern and the only pairing in the
  // palette with enough separation to register as a state change.
  //
  // Both the fill and the ink route through custom properties rather than literals: an inline
  // declaration carries no :hover and no :focus-visible, and would out-specify any stylesheet
  // rule that tried to add one. The indirection lets the injected stylesheet below light the
  // control up without a single `!important`, and leaves the control correctly sized, quiet
  // and legible even if that stylesheet never lands.
  function toolbarButtonCss({ square = false, bordered = false } = {}) {
    return (
      // Every control in here is a 32px box. That clears the 24px WCAG 2.5.8 target floor
      // with room to spare and is a recorded decision rather than a default. `min-height` as
      // well as `height` so an artifact's own `button { height: auto }` cannot shrink the
      // target, and an explicit `box-sizing` so a border eats into the box instead of growing
      // it by an amount that depends on which box model the artifact happens to have set.
      "box-sizing:border-box;min-width:32px;height:32px;min-height:32px;padding:" +
      (square ? "0" : "0 10px") +
      ";cursor:pointer;display:inline-flex;align-items:center;justify-content:center;" +
      "border-radius:0;border:0" +
      // A bordered control grows by exactly its own border, so the 32px of interior survives
      // the hairline instead of being eaten by it. That also lands it at the same 34px as the
      // segmented group beside it, which is 32px of segment plus its own border.
      (bordered
        ? ";height:34px;min-height:34px;border-radius:" +
          luxeToken("radius-nav", "8px") +
          ";border:" +
          luxeToken("stroke-hair", "1px") +
          " solid " +
          luxeToken("strong", "currentColor")
        : "") +
      ";background:var(--luxe-diagram-btn-bg, transparent);color:var(--luxe-diagram-btn-ink, " +
      luxeToken("ink-2", "currentColor") +
      ");font-family:" +
      luxeToken("font-sans", "inherit") +
      ";font-size:" +
      luxeToken("text-label", "inherit") +
      ";font-weight:" +
      luxeToken("weight-medium", "500") +
      ";letter-spacing:" +
      luxeToken("tracking-sans", "normal") +
      ";line-height:1"
    );
  }

  // Injection 5 of 5 outside the shadow DOM, and the only one an inline style could not do:
  // a declaration on an element carries no :hover and no :focus-visible.
  //
  // A control that does not change when you point at it is not discoverable, and zoom was
  // surfaced in the first place because nobody could find it. The lit state is therefore the
  // part of this that is not optional, and it is measured rather than eyeballed: --dark-fill
  // over the resting surface is 10.63:1 against --canvas and 11.67:1 against --surface-2.
  // The previous attempt used --surface-1 and came in at 1.04:1 - a state change nobody could
  // see, on a control with no border to see either.
  //
  // Everything here is either scoped to a `data-luxe-ui` element the artifact did not write
  // and cannot be styling, or wrapped in `:where()` so it has zero specificity and any
  // author rule beats it. No `!important` - the artifact still owns its own document.
  const diagramToolbarStyleId = "luxe-diagram-toolbar";
  const toolbarButtonSelectors = ['button[data-luxe-ui="diagram-toolbar"]', 'button[data-luxe-ui="whiteboard-edit"]'];
  // Set on a Mermaid container once Luxe has actually enhanced it into a diagram. It is the
  // difference between "a picture" and "a block of Mermaid source that never rendered" - and
  // the code-block framing below is only wrong for the first of those.
  const diagramContainerAttribute = "data-luxe-diagram";
  const enhancedDiagram = ".mermaid[" + diagramContainerAttribute + "]";

  function injectDiagramToolbarCss() {
    if (!document.head || document.getElementById(diagramToolbarStyleId)) return;
    // `:not(:disabled)` so a control at the clamp end, or the whiteboard button during
    // annotation, does not light up as if it were still live. A disabled button cannot take
    // focus, so :focus-visible needs no such guard.
    const lit = toolbarButtonSelectors
      .flatMap((base) => [base + ":hover:not(:disabled)", base + ":focus-visible"])
      .join(",");
    const focused = toolbarButtonSelectors.map((base) => base + ":focus-visible").join(",");
    const style = document.createElement("style");
    style.id = diagramToolbarStyleId;
    style.textContent =
      // A Mermaid diagram is very often a <pre>, and every code-block stylesheet in the world
      // ends in a bare `pre { background; border; border-radius }`. Luxe's own theme snippet
      // did, which means every artifact authored before this was drawing a picture inside a
      // code block's frame. It went unnoticed because the fill sat about two units off the
      // canvas; adding padding inside that frame is what made it obvious, by inflating it.
      //
      // Undoing it is a repair rather than a restyle: the frame says "this is source text"
      // about something that is not source text. It is scoped to containers Luxe actually
      // enhanced, so a diagram whose Mermaid never rendered - which really is showing source -
      // keeps the code-block treatment that correctly describes it.
      //
      // Specificity is the whole trick here. `:where()` would be zero and lose to the bare
      // `pre` this exists to beat, so the reset is written at two classes' worth: `.mermaid`
      // plus the attribute. That clears any element selector without reaching for
      // `!important`. An author who genuinely wants a framed diagram still wins by carrying
      // more weight than two classes, e.g. `.mermaid.mermaid[data-luxe-diagram] { border: … }`
      // or anything with an id in it.
      enhancedDiagram +
      "{background:transparent;border:0;border-radius:0;box-shadow:none}" +
      // Breathing room around the diagram itself. A Mermaid container sized to its SVG
      // plus a control strip has the diagram touching its own border on three sides.
      // Left at zero specificity, unlike the reset above: spacing is taste, and an author
      // who has an opinion about it should not have to out-specify anything to keep it.
      ":where(" +
      enhancedDiagram +
      "){padding:20px 16px}" +
      lit +
      "{--luxe-diagram-btn-bg:" +
      luxeToken("dark-fill", "Highlight") +
      ";--luxe-diagram-btn-ink:" +
      luxeToken("dark-fill-text", "HighlightText") +
      "}" +
      focused +
      "{outline:" +
      luxeToken("focus-ring-width", "2px") +
      " solid " +
      luxeToken("focus-ring", "currentColor") +
      ";outline-offset:" +
      luxeToken("focus-ring-offset", "2px") +
      "}";
    document.head.appendChild(style);
  }

  function makeToolbarButton(label, text, options) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-luxe-ui", "diagram-toolbar");
    // The visible glyph is decorative; the accessible name is the label. A screen reader
    // should hear "Zoom in", not "plus".
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = text;
    button.style.cssText = toolbarButtonCss(options);
    return button;
  }

  function addWhiteboardAffordance(svg, viewport) {
    const container = svg.closest(".mermaid");
    if (!container) return;
    const existing = whiteboardAffordances.get(container);
    if (existing && existing.button.isConnected) {
      existing.index = mermaidContainerIndex(container);
      setAffordanceState(existing);
      alignBarToDiagram(existing);
      return;
    }
    const index = mermaidContainerIndex(container);
    if (index < 0) return;
    // Mermaid renders asynchronously; a zero-ish rect means this svg has not
    // been laid out yet. Skip it and retry shortly - layout completion does not
    // necessarily mutate the DOM again, so the observer alone is not a
    // guaranteed wake-up.
    if (svg.getBoundingClientRect().height < 40) {
      window.setTimeout(scheduleMermaidEnhance, 150);
      return;
    }
    injectDiagramToolbarCss();
    // Marks this container as a rendered diagram rather than a block of Mermaid source, which
    // is what scopes the code-block reset in the stylesheet above. Deliberately not
    // `data-luxe-ui`: that attribute means "Luxe owns this element, keep it away from the
    // agent", and the diagram is the artifact's own content that the agent must still see.
    container.setAttribute(diagramContainerAttribute, "");

    const bar = document.createElement("div");
    bar.setAttribute("data-luxe-ui", "diagram-toolbar");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Diagram controls");
    // Normal flow under the diagram, wrapping when the artifact is narrow. Nothing here
    // is positioned, so there is no width at which it can land on top of the diagram.
    //
    // Right-aligned rather than full width: stretched across the container the strip read
    // as a button row that belonged to the page, not as controls that belong to the
    // diagram. The alignment is to the DIAGRAM's right edge, not the container's - see
    // alignBarToDiagram. A container-relative flex-end looks right under a full-width
    // flowchart and lands entirely beside a narrow one.
    bar.style.cssText =
      "display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;" +
      "margin-top:10px;font-family:" +
      luxeToken("font-sans", "inherit");

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-luxe-ui", "whiteboard-edit");
    button.style.cssText = toolbarButtonCss({ bordered: true });

    const entry = { button, index, bar, viewport, svg, container };
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      parent.postMessage({ type: "luxe:openWhiteboard", diagramIndex: entry.index }, "*");
    };

    // A diagram with no viewBox and no measurable bbox gets no viewport, and therefore no
    // zoom controls - but it still gets the whiteboard button, which does not depend on one.
    if (viewport) {
      const zoomOut = makeToolbarButton("Zoom out", "−", { square: true });
      const zoomIn = makeToolbarButton("Zoom in", "+", { square: true });
      const reset = makeToolbarButton("Reset zoom to fit", "100%");
      reset.style.cssText += ";min-width:48px;font-variant-numeric:tabular-nums";
      // The percentage is a readout as much as a control, so it keeps --ink-2 even when
      // resetting is a no-op.
      readoutControls.add(reset);

      // One segmented control instead of three loose buttons. The border is what says
      // "these are controls" now that nothing is filled, and drawing it once around the
      // group rather than three times around three pills is the whole point: same
      // affordance, a third of the object count. Dividers are --hair, the token for
      // internal rules, against a --strong outer edge, so the group reads as one object
      // with parts rather than three objects touching.
      //
      // No `overflow:hidden` to clip the segment corners: it would also clip the focus
      // ring, which outline-offset draws outside the group.
      const group = document.createElement("div");
      group.setAttribute("data-luxe-ui", "diagram-toolbar");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Diagram zoom");
      group.style.cssText =
        "box-sizing:border-box;display:inline-flex;align-items:center;background:transparent;border:" +
        luxeToken("stroke-hair", "1px") +
        " solid " +
        luxeToken("strong", "currentColor") +
        ";border-radius:" +
        luxeToken("radius-nav", "8px");
      for (const segment of [reset, zoomIn]) {
        segment.style.cssText +=
          ";border-left:" + luxeToken("stroke-hair", "1px") + " solid " + luxeToken("hair", "currentColor");
      }

      // Announce the level politely rather than on every wheel tick, so continuous
      // zooming does not flood a screen reader.
      const status = document.createElement("span");
      status.setAttribute("data-luxe-ui", "diagram-toolbar");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("role", "status");
      status.style.cssText =
        "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";

      let announceTimer;
      entry.updateZoom = () => {
        const percent = Math.round(viewport.getScale() * 100);
        reset.textContent = `${percent}%`;
        // The ends of the clamp disable rather than silently doing nothing.
        zoomIn.disabled = viewport.atMaxZoom();
        zoomOut.disabled = viewport.atMinZoom();
        reset.disabled = percent === 100;
        for (const control of [zoomIn, zoomOut, reset]) {
          control.setAttribute("aria-disabled", String(control.disabled));
          setControlEnabled(control, !control.disabled);
        }
        window.clearTimeout(announceTimer);
        announceTimer = window.setTimeout(() => {
          status.textContent = `Diagram zoom ${percent} percent`;
        }, 400);
      };

      zoomOut.onclick = () => viewport.zoomBy(1.25);
      zoomIn.onclick = () => viewport.zoomBy(1 / 1.25);
      reset.onclick = () => viewport.reset();
      viewport.subscribe(() => entry.updateZoom());

      // Scoped to the toolbar and the diagram, never document-global: the artifact owns
      // its own keyboard, and hijacking "+" across the page would break its controls.
      const onKeydown = (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "+" || event.key === "=") viewport.zoomBy(1 / 1.25);
        else if (event.key === "-" || event.key === "_") viewport.zoomBy(1.25);
        else if (event.key === "0") viewport.reset();
        else return;
        event.preventDefault();
      };
      bar.addEventListener("keydown", onKeydown);
      container.addEventListener("keydown", onKeydown);

      group.append(zoomOut, reset, zoomIn);
      bar.append(group, status);
      entry.updateZoom();
    }

    bar.appendChild(button);
    // After the diagram in document order, so tab order runs diagram then controls.
    container.appendChild(bar);
    whiteboardAffordances.set(container, entry);
    setAffordanceState(entry);
    alignBarToDiagram(entry);
    observeDiagramGeometry(entry);
  }

  // The strip's natural single-line width, measured from the controls rather than from the
  // bar - the bar wraps, so its own rect is not the answer. The live region is skipped
  // because it is absolutely positioned and 1px wide.
  function barNaturalWidth(bar) {
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    let total = 0;
    let count = 0;
    for (const child of bar.children) {
      if (getComputedStyle(child).position === "absolute") continue;
      total += child.getBoundingClientRect().width;
      count += 1;
    }
    return count ? total + gap * (count - 1) : 0;
  }

  // Align the strip to the DIAGRAM, not to the container.
  //
  // `justify-content: flex-end` alone aligns to the container, which is only the same thing
  // when the SVG fills it. Under a narrow diagram the strip ended up entirely to the right
  // of the thing it controls - measured at one point as a diagram spanning x 360-805 with
  // its own controls sitting at x 815-1075, touching nothing.
  //
  // Which edge it hugs depends on whether it can fit under the diagram at all. A strip
  // narrower than the diagram hugs the diagram's right edge, which is where the eye leaves
  // the diagram. A strip WIDER than the diagram cannot be contained by it, so it hugs the
  // left edge instead and runs rightwards into the free space - anchored to the diagram
  // either way, and never squeezed into a column narrower than itself, which is what made
  // it wrap onto two rows and spill past the container's padding.
  function alignBarToDiagram(entry) {
    const { bar, svg, container } = entry;
    if (!bar?.isConnected || !svg?.isConnected || !container) return;
    const svgRect = svg.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (svgRect.width <= 0 || containerRect.width <= 0) return;
    const style = getComputedStyle(container);
    const contentLeft =
      containerRect.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
    const contentRight =
      containerRect.right - (parseFloat(style.borderRightWidth) || 0) - (parseFloat(style.paddingRight) || 0);
    const fitsUnderDiagram = barNaturalWidth(bar) <= svgRect.width + 1;
    const next = fitsUnderDiagram
      ? { justifyContent: "flex-end", marginLeft: "0px", marginRight: px(contentRight - svgRect.right) }
      : { justifyContent: "flex-start", marginLeft: px(svgRect.left - contentLeft), marginRight: "0px" };
    // Write only on a real change. The container is under a ResizeObserver and its height
    // moves when the strip rewraps, so an unconditional write is a feedback loop.
    for (const [property, value] of Object.entries(next)) {
      if (bar.style[property] !== value) bar.style[property] = value;
    }
  }

  function px(value) {
    return Math.max(0, Math.round(value)) + "px";
  }

  // The diagram's rendered width is not fixed: fonts land late, the artifact reflows, the
  // window resizes. Re-align whenever the box the strip is aligned to actually changes,
  // rather than measuring once at build time and drifting.
  function observeDiagramGeometry(entry) {
    if (typeof ResizeObserver === "undefined" || entry.geometryObserver) return;
    const observer = new ResizeObserver(() => alignBarToDiagram(entry));
    observer.observe(entry.svg);
    observer.observe(entry.container);
    entry.geometryObserver = observer;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const msg = event.data || {};
    if (msg.type === "luxe:whiteboardOpened") openWhiteboardIndex = Number(msg.diagramIndex);
    else if (msg.type === "luxe:whiteboardClosed") openWhiteboardIndex = null;
    else return;
    refreshAffordances();
  });

  function enhanceMermaid() {
    for (const svg of findMermaidSvgs()) {
      // The viewport is built first: the toolbar's zoom controls drive it, so it has to
      // exist before the toolbar that reads from it. Previously the affordance was built
      // first, which was harmless only because it had nothing to read.
      if (!mermaidViewports.has(svg)) {
        const created = createViewport(svg);
        if (created) {
          created.setFrozen(annotationMode);
          mermaidViewports.set(svg, created);
        }
      }
      addWhiteboardAffordance(svg, mermaidViewports.get(svg) || null);
    }
  }

  let mermaidEnhanceScheduled = false;
  function scheduleMermaidEnhance() {
    if (mermaidEnhanceScheduled) return;
    mermaidEnhanceScheduled = true;
    const run = () => {
      mermaidEnhanceScheduled = false;
      enhanceMermaid();
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
    else window.setTimeout(run, 50);
  }

  function setMermaidFrozen(frozen) {
    for (const svg of findMermaidSvgs()) {
      mermaidViewports.get(svg)?.setFrozen(frozen);
    }
  }

  function closestElement(node) {
    if (!node) return document.body;
    if (node.nodeType === 1) return node;
    return node.parentElement || document.body;
  }

  function nodePath(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parentNode = current.parentNode;
      if (!parentNode) break;
      path.unshift([...parentNode.childNodes].indexOf(current));
      current = parentNode;
    }
    return path;
  }

  function rangeBoundary(node, offset) {
    const el = closestElement(node);
    return {
      selector: selector(el),
      path: nodePath(node, el),
      offset: Number(offset) || 0,
    };
  }

  function textSelectionContext(selection) {
    if (!selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const text = selection.toString().trim().replace(/\s+/g, " ");
    if (range.collapsed || !text) return null;

    const ancestor = closestElement(range.commonAncestorContainer);
    if (isLuxeUi(ancestor) || isLuxeAction(ancestor) || isInteractiveControl(ancestor)) return null;

    const commonAncestorSelector = selector(ancestor);
    const target = {
      type: "text-range",
      text,
      selector: commonAncestorSelector,
      commonAncestorSelector,
      start: rangeBoundary(range.startContainer, range.startOffset),
      end: rangeBoundary(range.endContainer, range.endOffset),
    };

    return {
      uid: "",
      selector: commonAncestorSelector,
      tag: "text",
      text: text.slice(0, 240),
      target,
      element: ancestor,
      range: range.cloneRange(),
    };
  }

  function isLuxeUi(el) {
    return !!(el && el.closest && el.closest("[data-luxe-ui]"));
  }

  function isLuxeAction(el) {
    return !!(el && el.closest && el.closest("[data-luxe-action]"));
  }

  // Native interactive controls (radios, checkboxes, inputs, selects, buttons,
  // labels, disclosure summaries, editable regions) should toggle/focus/type
  // natively instead of triggering annotation, just like elements marked with
  // data-luxe-action.
  function isInteractiveControl(el) {
    return isNativeInteractive(el);
  }

  // Injection 1 of 5 that reaches outside the shadow DOM: an inline style on the
  // artifact's own element. Both custom properties are defined by injection 2
  // (the :root block in setAnnotationMode), which always runs first because the
  // chrome enables annotate mode before any element can be hovered.
  function highlightElement(el) {
    if (!el) return;
    el.style.outline = "var(--luxe-annotate-outline)";
    el.style.outlineOffset = "var(--luxe-annotate-offset)";
  }

  function clearHighlight(el) {
    if (el) el.style.outline = "";
  }

  function clearTextHighlight() {
    if (!shadow) return;
    for (const el of [...shadow.querySelectorAll(".luxe-text-highlight")]) el.remove();
  }

  function highlightTextRange(range) {
    clearTextHighlight();
    const root = ensureShadow();
    for (const rect of [...range.getClientRects()]) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const mark = document.createElement("div");
      mark.className = "luxe-text-highlight";
      mark.style.left = rect.left + "px";
      mark.style.top = rect.top + "px";
      mark.style.width = rect.width + "px";
      mark.style.height = rect.height + "px";
      root.appendChild(mark);
    }
  }

  // The session is over. Tear the annotation layer down the way turning annotation off would,
  // then retire every Luxe-owned control in the artifact for good. The artifact itself stays
  // readable and interactive - ending a review does not take the document away.
  function setSessionEnded() {
    if (sessionEnded) return;
    sessionEnded = true;
    setAnnotationMode(false);
    refreshAffordances();
  }

  function setAnnotationMode(enabled) {
    if (sessionEnded) enabled = false;
    annotationMode = !!enabled;
    let style = document.getElementById("luxe-cursor-style");
    if (annotationMode && !style) {
      style = document.createElement("style");
      style.id = "luxe-cursor-style";
      // Injection 2 of 5 outside the shadow DOM: this writes into the artifact
      // page's own :root. Only the annotation accent crosses over, and its value
      // comes from the design tokens rather than a literal. currentColor is the
      // no-colour fallback for the case where the token text never arrived.
      style.textContent =
        ":root{--luxe-accent:" +
        luxeToken("gold", "currentColor") +
        ";--luxe-annotate-outline:2px solid var(--luxe-accent);--luxe-annotate-offset:2px}*{cursor:default!important}[data-luxe-action],[data-luxe-action] *{cursor:pointer!important}input,textarea,[contenteditable]:not([contenteditable='false']){cursor:text!important}button,select,label,option,input[type='button'],input[type='submit'],input[type='reset'],input[type='checkbox'],input[type='radio'],input[type='file'],input[type='color'],input[type='range'],input[type='image']{cursor:pointer!important}";
      document.head.appendChild(style);
    }
    if (!annotationMode && style) style.remove();
    if (!annotationMode) closeCard();

    // Freeze Mermaid pan/zoom while annotating so nodes sit at stable screen
    // positions and a click resolves cleanly to one node instead of panning.
    setMermaidFrozen(annotationMode);
    // Annotating a diagram and editing it as a whiteboard are different jobs;
    // the affordance steps aside while the annotation layer owns the SVG.
    refreshAffordances();
  }

  function queuePrompt(prompt, options = {}) {
    const originElement = options.element || document.activeElement || document.body;
    /** @type {{ uid: string, prompt: string, selector: string, tag: string, text: string, topic?: string, target?: unknown, _luxeQueueKey?: string }} */
    const item = {
      ...context(originElement),
      prompt: String(prompt || ""),
    };
    const queueKey = typeof deriveQueueKey === "function" ? deriveQueueKey(originElement, options) : "";
    if (queueKey) item._luxeQueueKey = String(queueKey);

    if (options.uid) item.uid = String(options.uid);
    if (options.selector) item.selector = String(options.selector);
    if (options.tag) item.tag = String(options.tag);
    if (options.text) item.text = String(options.text);
    // A short human name for what this prompt is about - "Billing plan", "Rollout date".
    // It is what the queued pill and the conversation receipt are titled with, so the
    // reviewer reads their own question back rather than a dedupe key or a prompt
    // fragment. Optional: without it Luxe derives something from the queue key and then
    // from the prompt, which is always worse than a name the author chose.
    if (options.topic) item.topic = String(options.topic).slice(0, 80);
    if (options.target) item.target = options.target;
    if (options.data) item.prompt += "\n\nContext data:\n" + JSON.stringify(options.data, null, 2);

    annotationSequence += 1;
    parent.postMessage({ type: "luxe:queuePrompt", prompt: item }, "*");
  }

  function snapshot() {
    function snapshotVisibility(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.contentVisibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") <= 0 ||
        isStandardVisuallyHidden(el, style, rect)
      ) {
        return { includeSelf: false, traverseChildren: false };
      }
      if (
        style.display === "contents" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        ![...el.getClientRects()].some((candidate) => candidate.width > 0 && candidate.height > 0)
      ) {
        return { includeSelf: false, traverseChildren: true };
      }
      return { includeSelf: true, traverseChildren: true };
    }

    function directText(el) {
      return [...el.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => String(node.textContent || ""))
        .join(" ")
        .trim()
        .replace(/\s+/g, " ");
    }

    return snapshotBuilder(document.body, {
      isElement: (el) => el instanceof Element,
      visibility: snapshotVisibility,
      isExcluded: isLuxeUi,
      describe: (element) => {
        const el = /** @type {HTMLElement} */ (element);
        return {
          uid: uid(el),
          tag: el.tagName.toLowerCase(),
          text: directText(el),
        };
      },
      childrenOf: (element) => /** @type {Element} */ (element).children,
    });
  }

  const layoutAuditSettleMs = 180;
  const layoutAuditMaxWaitMs = 2000;
  const layoutAuditAnimationMaxWaitMs = 4000;
  const layoutAuditStableSampleMs = 120;
  let layoutAuditTimer = 0;
  let layoutAuditRun = 0;
  let lastLayoutAuditSignature = null;

  function toPixelNumber(value) {
    const parsed = Number.parseFloat(String(value || "0"));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function roundedOverflowPx(value) {
    return Math.round(Math.max(0, value) * 10) / 10;
  }

  function elementText(el) {
    return String(el?.innerText || el?.textContent || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function directText(el) {
    return [...(el?.childNodes || [])]
      .filter((node) => node.nodeType === 3)
      .map((node) => String(node.textContent || ""))
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function isRequiredControl(el) {
    if (!el?.matches?.("button,input,select,textarea,a[href],summary,[data-luxe-action],[role]")) return false;
    if (el.matches("input[type='hidden'],[disabled],[aria-disabled='true']")) return false;
    if (!el.hasAttribute("role")) return true;
    return new Set(["button", "link", "checkbox", "radio", "switch", "textbox", "combobox"]).has(
      String(el.getAttribute("role") || "").toLowerCase(),
    );
  }

  function isSemanticTextBoundary(el) {
    return Boolean(
      el?.matches?.(
        "p,h1,h2,h3,h4,h5,h6,button,label,a[href],li,dt,dd,th,td,legend,figcaption,summary,[role='button'],[role='link'],[role='alert'],[role='status']",
      ),
    );
  }

  function hasSemanticTextBoundaryAncestor(el) {
    let node = el?.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isSemanticTextBoundary(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function auditedText(el) {
    return isSemanticTextBoundary(el) ? elementText(el) : directText(el);
  }

  function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function isVisibleForLayoutAudit(el, rect = el.getBoundingClientRect()) {
    if (!el || isLuxeUi(el) || rect.width <= 0 || rect.height <= 0) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);
      const opacity = Number.parseFloat(style.opacity || "1");
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.contentVisibility === "hidden" ||
        (Number.isFinite(opacity) && opacity <= 0.01)
      ) {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  }

  function isIntentionalHorizontalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowX = getComputedStyle(el).overflowX;
    return overflowX === "auto" || overflowX === "scroll";
  }

  function isIntentionalVerticalScroller(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const overflowY = getComputedStyle(el).overflowY;
    return overflowY === "auto" || overflowY === "scroll";
  }

  function hasIntentionalHorizontalScrollerAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (isIntentionalHorizontalScroller(node)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function hasReachableVerticalScrollerAncestor(el) {
    let node = el?.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isIntentionalVerticalScroller(node)) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < (window.innerHeight || 0)) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function rootVerticalScrollLocked() {
    const values = [document.documentElement, document.body]
      .filter(Boolean)
      .map((node) => getComputedStyle(node).overflowY);
    return values.some((value) => value === "hidden" || value === "clip");
  }

  function paddingBoxRect(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      left: rect.left + toPixelNumber(style.borderLeftWidth),
      right: rect.right - toPixelNumber(style.borderRightWidth),
      top: rect.top + toPixelNumber(style.borderTopWidth),
      bottom: rect.bottom - toPixelNumber(style.borderBottomWidth),
    };
  }

  function textNodesForAudit(el) {
    const descendants = isSemanticTextBoundary(el);
    const nodes = [];
    const pending = [...(el?.childNodes || [])];
    while (pending.length > 0) {
      const node = pending.shift();
      if (!node) continue;
      if (node.nodeType === 3) {
        if (String(node.textContent || "").trim()) nodes.push(node);
      } else if (descendants && node.nodeType === 1) {
        pending.unshift(...(node.childNodes || []));
      }
    }
    return nodes;
  }

  function textFragmentsForAudit(el) {
    const fragments = [];
    for (const textNode of textNodesForAudit(el)) {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      fragments.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
      range.detach?.();
    }
    return fragments;
  }

  function isIntentionalTextTruncation(style) {
    return style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp || "0", 10) > 0;
  }

  function hasVisualMask(style) {
    const maskImage = String(style.maskImage || style.webkitMaskImage || "none").toLowerCase();
    const clipPath = String(style.clipPath || "none").toLowerCase();
    return (maskImage !== "none" && maskImage !== "") || (clipPath !== "none" && clipPath !== "");
  }

  function isRoundedOverflowMask(style) {
    const clips =
      style.overflowX === "hidden" ||
      style.overflowX === "clip" ||
      style.overflowY === "hidden" ||
      style.overflowY === "clip";
    if (!clips) return false;
    return [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].some((value) => toPixelNumber(value) > 0);
  }

  function isDiagramLayoutElement(el) {
    return Boolean(el?.closest?.(".mermaid,svg,[data-luxe-ui]"));
  }

  function hasVisualMaskAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);
      if (hasVisualMask(style) || isRoundedOverflowMask(style)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function clippingBoundariesFor(el) {
    const boundaries = [];
    let node = el?.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const axes = [];
      if (style.overflowX === "hidden" || style.overflowX === "clip") axes.push("horizontal");
      if (style.overflowY === "hidden" || style.overflowY === "clip") axes.push("vertical");
      if (axes.length > 0 && !hasVisualMask(style) && !isRoundedOverflowMask(style)) {
        boundaries.push({ el: node, box: paddingBoxRect(node), axes });
      }
      node = node.parentElement;
    }
    return boundaries;
  }

  function isStandardVisuallyHidden(el, style, rect) {
    const positioned = style.position === "absolute" || style.position === "fixed";
    const clipped = style.overflowX === "hidden" || style.overflowX === "clip";
    const legacyClip = String(style.clip || "").toLowerCase();
    const clipPath = String(style.clipPath || "").toLowerCase();
    const hasClip = legacyClip !== "auto" || (clipPath !== "none" && clipPath !== "");
    return positioned && clipped && rect.width <= 2 && rect.height <= 2 && (style.whiteSpace === "nowrap" || hasClip);
  }

  function hasStandardVisuallyHiddenAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const rect = node.getBoundingClientRect();
      if (isStandardVisuallyHidden(node, getComputedStyle(node), rect)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isExcludedLayoutAuditElement(el) {
    return isDiagramLayoutElement(el) || hasVisualMaskAncestor(el) || hasStandardVisuallyHiddenAncestor(el);
  }

  function collectLayoutAuditElements() {
    return [...(document.body?.querySelectorAll("*") || [])]
      .filter((el) => el instanceof Element && !isLuxeUi(el))
      .slice(0, 800);
  }

  function pushLayoutFinding(findings, seen, finding) {
    if (finding.severity !== "error") return;
    const selectorValue = finding.selector || "";
    const axis = finding.axis === "vertical" ? "vertical" : "horizontal";
    const key = `${finding.kind}:${selectorValue}:${axis}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      selector: selectorValue,
      kind: String(finding.kind || "layout-failure"),
      axis,
      overflowPx: roundedOverflowPx(finding.overflowPx),
      viewportWidth: Math.round(Number(finding.viewportWidth) || window.innerWidth || 0),
      severity: "error",
    });
  }

  function auditSevereTextOverflow(el, viewportWidth, findings, seen, animationTargets, failedRoots) {
    if (el === document.body || el === document.documentElement) return;
    if (isExcludedLayoutAuditElement(el)) return;
    if (!auditedText(el)) return;
    if (!isSemanticTextBoundary(el) && hasSemanticTextBoundaryAncestor(el)) return;
    if (failedRoots.some((root) => root.contains(el))) return;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return;

    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;
    const style = getComputedStyle(el);
    const fragments = textFragmentsForAudit(el);
    let severe = classifySevereTextOverflow({
      fragments,
      box: paddingBoxRect(el),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      isTruncated: isIntentionalTextTruncation(style),
      isVisuallyHidden: false,
    });
    let failureRoot = el;
    for (const boundary of clippingBoundariesFor(el)) {
      const ancestorFailure = classifySevereTextOverflow({
        fragments,
        box: boundary.box,
        overflowX: boundary.axes.includes("horizontal") ? "hidden" : "auto",
        overflowY: boundary.axes.includes("vertical") ? "hidden" : "auto",
        isTruncated: isIntentionalTextTruncation(style),
        isVisuallyHidden: false,
      });
      if (ancestorFailure && (!severe || ancestorFailure.overflowPx > severe.overflowPx)) {
        severe = ancestorFailure;
        failureRoot = boundary.el;
      }
    }
    if (!severe) return;

    failedRoots.push(failureRoot);
    pushLayoutFinding(findings, seen, {
      selector: selector(failureRoot),
      kind: severe.kind,
      axis: severe.axis,
      overflowPx: severe.overflowPx,
      viewportWidth,
      severity: "error",
    });
  }

  function materiallyEscapesViewport(rect, viewportWidth, minOutsidePx) {
    return classifyMaterialRectEscape({
      rect,
      boundary: { left: 0, right: viewportWidth, top: 0, bottom: window.innerHeight || 0 },
      axes: ["horizontal"],
      minOutsidePx,
    });
  }

  function elementHasMaterialViewportEscape(el, viewportWidth, animationTargets) {
    if (hasIntentionalHorizontalScrollerAncestor(el)) return false;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return false;
    if (isExcludedLayoutAuditElement(el)) return false;
    if (!isSemanticTextBoundary(el) && hasSemanticTextBoundaryAncestor(el)) return false;

    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return false;
    const style = getComputedStyle(el);
    const positioned = style.position === "absolute" || style.position === "fixed" || style.position === "sticky";
    if (positioned && !isRequiredControl(el)) return false;
    if (isRequiredControl(el)) {
      return materiallyEscapesViewport(rect, viewportWidth, 4)?.side === "end";
    }
    if (!auditedText(el)) return false;
    const materialPx = Math.max(24, viewportWidth * 0.05);
    return textFragmentsForAudit(el).some(
      (fragment) => materiallyEscapesViewport(fragment, viewportWidth, materialPx)?.side === "end",
    );
  }

  function auditUnreachableLeftText(el, viewportWidth, findings, seen, animationTargets) {
    if (hasIntentionalHorizontalScrollerAncestor(el)) return;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return;
    if (isExcludedLayoutAuditElement(el)) return;
    if (!isSemanticTextBoundary(el) && hasSemanticTextBoundaryAncestor(el)) return;
    if (!auditedText(el)) return;
    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;
    const style = getComputedStyle(el);
    if (["absolute", "fixed", "sticky"].includes(style.position) && !isRequiredControl(el)) return;
    const materialPx = Math.max(24, viewportWidth * 0.05);
    let escape = null;
    for (const fragment of textFragmentsForAudit(el)) {
      const candidate = materiallyEscapesViewport(fragment, viewportWidth, materialPx);
      if (candidate?.side === "start" && (!escape || candidate.overflowPx > escape.overflowPx)) escape = candidate;
    }
    if (!escape) return;
    pushLayoutFinding(findings, seen, {
      selector: selector(el),
      kind: "viewport-unreachable-content",
      axis: "horizontal",
      overflowPx: escape.overflowPx,
      viewportWidth,
      severity: "error",
    });
  }

  function auditRequiredControlBounds(el, viewportWidth, findings, seen, animationTargets, failedRoots) {
    if (!isRequiredControl(el) || isExcludedLayoutAuditElement(el)) return;
    if (isAnimationAssociatedWithElement(el, animationTargets)) return;
    const rect = el.getBoundingClientRect();
    if (!isVisibleForLayoutAudit(el, rect)) return;

    let clipped = null;
    for (const boundary of clippingBoundariesFor(el)) {
      const escape = classifyMaterialRectEscape({ rect, boundary: boundary.box, axes: boundary.axes });
      if (escape && (!clipped || escape.overflowPx > clipped.escape.overflowPx)) clipped = { boundary, escape };
    }
    if (clipped && !failedRoots.some((root) => root === clipped.boundary.el || root.contains(clipped.boundary.el))) {
      failedRoots.push(clipped.boundary.el);
      pushLayoutFinding(findings, seen, {
        selector: selector(clipped.boundary.el),
        kind: "clipped-control",
        axis: clipped.escape.axis,
        overflowPx: clipped.escape.overflowPx,
        viewportWidth,
        severity: "error",
      });
    }

    const horizontal = hasIntentionalHorizontalScrollerAncestor(el)
      ? null
      : materiallyEscapesViewport(rect, viewportWidth, 4);
    if (horizontal?.side === "start") {
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: "viewport-unreachable-control",
        axis: "horizontal",
        overflowPx: horizontal.overflowPx,
        viewportWidth,
        severity: "error",
      });
    }

    const style = getComputedStyle(el);
    const fixedToViewport = style.position === "fixed" || style.position === "sticky";
    const lockedToViewport = rootVerticalScrollLocked() && !hasReachableVerticalScrollerAncestor(el);
    const scrollY = Number(window.scrollY || window.pageYOffset || 0);
    const verticalRect =
      fixedToViewport || lockedToViewport
        ? rect
        : {
            top: rect.top + scrollY,
            bottom: rect.bottom + scrollY,
            height: rect.height,
          };
    const verticalBoundary =
      fixedToViewport || lockedToViewport
        ? { top: 0, bottom: window.innerHeight || 0 }
        : { top: 0, bottom: document.documentElement.scrollHeight };
    const vertical = classifyMaterialRectEscape({
      rect: verticalRect,
      boundary: verticalBoundary,
      axes: ["vertical"],
    });
    if (vertical) {
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: "viewport-unreachable-control",
        axis: "vertical",
        overflowPx: vertical.overflowPx,
        viewportWidth,
        severity: "error",
      });
    }
  }

  function backgroundIsOpaque(el) {
    const style = getComputedStyle(el);
    if (Number.parseFloat(style.opacity || "1") < 0.95) return false;
    const color = String(style.backgroundColor || "")
      .trim()
      .toLowerCase();
    if (!color || color === "transparent") return false;
    const rgba = color.match(/^rgba?\(([^)]+)\)$/);
    if (!rgba) return false;
    const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return true;
    const alpha = Number(parts[3]);
    return Number.isFinite(alpha) && alpha >= 0.95;
  }

  function effectiveOpacityTo(node, stopParent) {
    let opacity = 1;
    let current = node;
    while (current && current !== stopParent) {
      const value = Number.parseFloat(getComputedStyle(current).opacity || "1");
      if (Number.isFinite(value)) opacity *= value;
      current = current.parentElement;
    }
    return opacity;
  }

  function opaqueSiblingBlocker(el, point, animationTargets) {
    const top = document.elementFromPoint(point.x, point.y);
    if (!(top instanceof Element) || top === el || el.contains(top) || top.contains(el) || isLuxeUi(top)) return null;

    const targetAncestors = [];
    let targetNode = el;
    while (targetNode && targetNode !== document.body && targetNode !== document.documentElement) {
      targetAncestors.push(targetNode);
      targetNode = targetNode.parentElement;
    }

    let node = top;
    let foundOpaqueSurface = false;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isAnimationAssociatedWithElement(node, animationTargets)) return null;
      if (backgroundIsOpaque(node)) foundOpaqueSurface = true;
      const siblingOf = targetAncestors.find((target) => target.parentElement === node.parentElement);
      if (siblingOf && foundOpaqueSurface && effectiveOpacityTo(top, node.parentElement) >= 0.95) return node;
      node = node.parentElement;
    }
    return null;
  }

  function fragmentSamplePoints(fragment) {
    const xs = [0.2, 0.5, 0.8];
    const ys = [0.2, 0.5, 0.8];
    return xs.flatMap((xRatio) =>
      ys.map((yRatio) => ({
        x: fragment.left + fragment.width * xRatio,
        y: fragment.top + fragment.height * yRatio,
      })),
    );
  }

  function auditSevereTextOcclusion(elements, viewportWidth, findings, seen, animationTargets) {
    const candidates = elements
      .filter((el) => !isExcludedLayoutAuditElement(el))
      .filter((el) => {
        const text = auditedText(el);
        return text.length >= 8 || (text.length > 0 && isRequiredControl(el));
      })
      .filter((el) => isSemanticTextBoundary(el) || !hasSemanticTextBoundaryAncestor(el))
      .filter((el) => isVisibleForLayoutAudit(el))
      .filter((el) => getComputedStyle(el).position === "static")
      .filter((el) => !isAnimationAssociatedWithElement(el, animationTargets))
      .slice(0, 200);
    const failedRoots = [];

    for (const el of candidates) {
      if (failedRoots.some((root) => root.contains(el))) continue;
      const blockers = new Map();
      let totalSamples = 0;
      for (const fragment of textFragmentsForAudit(el)) {
        if (rectArea(fragment) < 16) continue;
        for (const point of fragmentSamplePoints(fragment)) {
          if (point.x < 0 || point.y < 0 || point.x > viewportWidth || point.y > window.innerHeight) continue;
          totalSamples += 1;
          const blocker = opaqueSiblingBlocker(el, point, animationTargets);
          if (blocker) blockers.set(blocker, (blockers.get(blocker) || 0) + 1);
        }
      }
      const occludedSamples = Math.max(0, ...blockers.values());
      if (!isNearTotalOcclusion({ occludedSamples, totalSamples })) continue;
      failedRoots.push(el);
      pushLayoutFinding(findings, seen, {
        selector: selector(el),
        kind: "overlapping-text",
        axis: "horizontal",
        overflowPx: 0,
        viewportWidth,
        severity: "error",
      });
    }
  }

  function auditLayout() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const findings = [];
    const seen = new Set();
    const elements = collectLayoutAuditElements();
    const animationTargets = activeAnimationTargets();
    const pageOverflowPx = document.documentElement.scrollWidth - viewportWidth;
    const escapedContent = elements.some((el) => elementHasMaterialViewportEscape(el, viewportWidth, animationTargets));
    if (isMaterialPageOverflow({ overflowPx: pageOverflowPx, viewportWidth, hasEscapedContent: escapedContent })) {
      pushLayoutFinding(findings, seen, {
        selector: "html",
        kind: "page-horizontal-overflow",
        axis: "horizontal",
        overflowPx: pageOverflowPx,
        viewportWidth,
        severity: "error",
      });
    }

    const failedClippingRoots = [];
    for (const el of elements) {
      auditRequiredControlBounds(el, viewportWidth, findings, seen, animationTargets, failedClippingRoots);
    }
    for (const el of elements) {
      auditUnreachableLeftText(el, viewportWidth, findings, seen, animationTargets);
    }
    for (const el of elements) {
      auditSevereTextOverflow(el, viewportWidth, findings, seen, animationTargets, failedClippingRoots);
    }
    auditSevereTextOcclusion(elements, viewportWidth, findings, seen, animationTargets);
    return findings;
  }

  function waitForDocumentFontsReady() {
    try {
      if (document.fonts?.ready) return document.fonts.ready.catch(() => {});
    } catch {
      // Ignore font readiness failures. The ResizeObserver settle below is still a safety net.
    }
    return Promise.resolve();
  }

  function waitForAnimationFrames(count) {
    return new Promise((resolve) => {
      function step(remaining) {
        if (remaining <= 0) {
          resolve();
          return;
        }
        const next = () => step(remaining - 1);
        if (window.requestAnimationFrame) {
          window.requestAnimationFrame(next);
        } else {
          window.setTimeout(next, 16);
        }
      }
      step(count);
    });
  }

  function waitForResizeObserverSettle() {
    return new Promise((resolve) => {
      let observer = null;
      let settleTimer = 0;
      let maxTimer = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (settleTimer) window.clearTimeout(settleTimer);
        if (maxTimer) window.clearTimeout(maxTimer);
        if (observer) observer.disconnect();
        resolve();
      };
      const scheduleFinish = () => {
        if (settleTimer) window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(finish, layoutAuditSettleMs);
      };

      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(scheduleFinish);
        const observed = [document.documentElement, document.body, ...[...(document.body?.querySelectorAll("*") || [])]]
          .filter(Boolean)
          .slice(0, 800);
        for (const el of observed) observer.observe(el);
      }

      scheduleFinish();
      maxTimer = window.setTimeout(finish, layoutAuditMaxWaitMs);
    });
  }

  function animationTarget(animation) {
    const target = /** @type {any} */ (animation.effect)?.target;
    if (target instanceof Element) return target;
    return target?.element instanceof Element ? target.element : null;
  }

  function activeDocumentAnimations() {
    if (typeof document.getAnimations !== "function") return [];
    return document
      .getAnimations()
      .filter((animation) => ["running", "pending"].includes(String(animation.playState)))
      .filter((animation) => !isLuxeUi(animationTarget(animation)));
  }

  function activeAnimationTargets() {
    return activeDocumentAnimations().map(animationTarget).filter(Boolean);
  }

  function isAnimationAssociatedWithElement(el, targets) {
    return targets.some((target) => target === el || target.contains(el) || el.contains(target));
  }

  async function waitForFiniteAnimationsSettle() {
    const finite = activeDocumentAnimations().filter((animation) => {
      const endTime = Number(animation.effect?.getComputedTiming?.().endTime);
      return Number.isFinite(endTime);
    });
    if (finite.length === 0) return;

    let settled = false;
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => {}))).then(() => {
        settled = true;
      }),
      new Promise((resolve) => window.setTimeout(resolve, layoutAuditAnimationMaxWaitMs)),
    ]);
    if (!settled) {
      for (const animation of finite) animation.finished.then(scheduleLayoutAudit, scheduleLayoutAudit);
    }
  }

  function publishLayoutAudit(layout_warnings) {
    const severe = layout_warnings.filter((finding) => finding?.severity === "error");
    const signature = JSON.stringify(severe);
    if (signature === lastLayoutAuditSignature) return;
    lastLayoutAuditSignature = signature;
    parent.postMessage({ type: "luxe:layoutWarnings", layout_warnings: severe }, "*");
  }

  async function runLayoutAudit(runId) {
    await waitForDocumentFontsReady();
    await waitForResizeObserverSettle();
    await waitForFiniteAnimationsSettle();
    await waitForAnimationFrames(2);
    if (runId !== layoutAuditRun) return;

    const first = auditLayout();
    await new Promise((resolve) => window.setTimeout(resolve, layoutAuditStableSampleMs));
    await waitForAnimationFrames(2);
    if (runId !== layoutAuditRun) return;
    publishLayoutAudit(findStableLayoutFindings(first, auditLayout()));
  }

  function scheduleLayoutAudit() {
    if (layoutAuditTimer) window.clearTimeout(layoutAuditTimer);
    const runId = ++layoutAuditRun;
    layoutAuditTimer = window.setTimeout(() => {
      runLayoutAudit(runId).catch(() => {
        if (runId === layoutAuditRun) publishLayoutAudit([]);
      });
    }, 50);
  }

  function startLayoutAudit() {
    scheduleLayoutAudit();
    window.addEventListener("load", scheduleLayoutAudit, { once: true });
    window.addEventListener("resize", scheduleLayoutAudit, { passive: true });
    window.addEventListener("animationend", scheduleLayoutAudit, { passive: true });
    window.addEventListener("transitionend", scheduleLayoutAudit, { passive: true });
  }

  function ensureShadow() {
    if (shadow) return shadow;

    const host = document.createElement("div");
    host.className = "luxe-annotation-root";
    host.setAttribute("data-luxe-ui", "annotation-root");
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // The design tokens arrive as CSS text and are re-scoped from :root to :host,
    // because `all:initial` cuts the shadow root off from the artifact page (it
    // does not reset custom properties, so the block below still resolves). Every
    // rule after it references a token; no colour is written here.
    style.textContent =
      luxeTokensCss.replace(/:root(\s*\{)/, ":host$1") +
      `:host{all:initial;position:fixed;z-index:2147483647;left:0;top:0;font-family:var(--font-sans);letter-spacing:var(--tracking-sans)}*{box-sizing:border-box}:focus-visible{outline:var(--focus-ring-width) solid var(--focus-ring);outline-offset:var(--focus-ring-offset)}.luxe-text-highlight{position:fixed;pointer-events:none;background:var(--gold-wash);border-radius:2px}.luxe-annotation-badge{position:fixed;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--radius-pill);background:var(--gold);color:var(--ink-1);border:2px solid var(--canvas);font-size:var(--text-label);font-weight:var(--weight-medium);line-height:1;pointer-events:none}.luxe-annotation-card{position:fixed;width:min(320px,calc(100vw - 24px));padding:16px;border-radius:var(--radius-card);background:var(--surface-2);color:var(--ink-1);border:var(--stroke-hair) solid var(--strong);box-shadow:0 2px 6px rgba(33,30,23,.10),var(--shadow-modal);font-size:var(--text-control);line-height:var(--leading-body)}.luxe-heading{font-weight:var(--weight-medium);margin-bottom:8px}.luxe-annotation-card textarea{width:100%;min-height:86px;resize:vertical;border-radius:var(--radius-nav);border:var(--stroke-hair) solid var(--hair);background:var(--surface-2);color:var(--ink-1);padding:10px 12px;font-family:var(--font-sans);font-size:var(--text-control);line-height:var(--leading-body);letter-spacing:var(--tracking-sans)}.luxe-annotation-card textarea::placeholder{color:var(--ink-3)}.luxe-annotation-card .luxe-hint{margin-top:8px;font-size:var(--text-label);color:var(--ink-2)}.luxe-annotation-card .luxe-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.luxe-annotation-card button{border:var(--stroke-hair) solid transparent;border-radius:var(--radius-pill);padding:8px 16px;font-family:var(--font-sans);font-size:var(--text-control);font-weight:var(--weight-medium);letter-spacing:var(--tracking-sans);cursor:pointer}.luxe-annotation-card .luxe-send{background:var(--dark-fill);color:var(--dark-fill-text)}.luxe-annotation-card .luxe-send:hover{background:var(--dark-fill-hover)}.luxe-annotation-card .luxe-cancel{background:var(--surface-2);border-color:var(--strong);color:var(--ink-1)}.luxe-annotation-card .luxe-cancel:hover{background:var(--canvas)}`;
    shadow.appendChild(style);
    return shadow;
  }

  // The numbered badge that marks the element being annotated. --ink-1 on gold:
  // white on gold is 3.25:1 and fails, which is a fixed deviation of the demo.
  function showAnnotationBadge(rect, number) {
    const root = ensureShadow();
    clearAnnotationBadge();
    const badge = document.createElement("div");
    badge.className = "luxe-annotation-badge";
    badge.textContent = String(number);
    badge.style.left = Math.max(2, rect.right - 12) + "px";
    badge.style.top = Math.max(2, rect.top - 12) + "px";
    root.appendChild(badge);
  }

  function clearAnnotationBadge() {
    if (!shadow) return;
    for (const el of [...shadow.querySelectorAll(".luxe-annotation-badge")]) el.remove();
  }

  // True while a card is open with text the reviewer typed but has not queued.
  // Dismiss-on-outside-click respects this so a stray click never destroys a draft;
  // Cancel and Queue still close unconditionally, because those are explicit intent.
  function cardHasDraft() {
    if (!shadow) return false;
    const textarea = shadow.querySelector(".luxe-annotation-card textarea");
    return !annotationCardDismissPolicy(true, textarea ? textarea.value : "");
  }

  function isPageBackdrop(el) {
    return el === document.body || el === document.documentElement;
  }

  function cardIsOpen() {
    return Boolean(shadow && shadow.querySelector(".luxe-annotation-card"));
  }

  // Dismiss without discarding work. Returns true when the card actually closed.
  function dismissCard() {
    if (!cardIsOpen() || cardHasDraft()) return false;
    closeCard();
    return true;
  }

  function closeCard() {
    if (shadow) {
      for (const el of [...shadow.querySelectorAll(".luxe-annotation-card")]) el.remove();
    }
    clearAnnotationBadge();
    clearHighlight(hovered);
    clearHighlight(selected);
    hovered = null;
    clearTextHighlight();
    selected = null;
  }

  function showAnnotationCard(target, options = {}) {
    const root = ensureShadow();
    closeCard();

    const c = options.context || context(target);
    let anchor = target;
    if (options.range) {
      highlightTextRange(options.range);
    } else {
      anchor = annotationTargetEl(target);
      selected = anchor;
      highlightElement(selected);
    }

    const rect = options.range ? options.range.getBoundingClientRect() : anchor.getBoundingClientRect();
    showAnnotationBadge(rect, annotationSequence + 1);
    const card = document.createElement("div");
    card.className = "luxe-annotation-card";
    const nodeLabel = c.tag === "mermaid-node" ? c.target?.label || c.text || "" : "";
    const heading =
      c.tag === "text"
        ? "Annotate text"
        : c.tag === "mermaid-node"
          ? "Annotate node" + (nodeLabel ? ": " + escapeAnnotationText(nodeLabel) : "")
          : "Annotate " + friendlyElementName(c.tag);
    const placeholder =
      c.tag === "text"
        ? "Tell the agent what to change about this text..."
        : c.tag === "mermaid-node"
          ? "Tell the agent what to change about this diagram node..."
          : "Tell the agent what to change about this element...";
    card.innerHTML =
      '<div class="luxe-heading">' +
      heading +
      '</div><textarea placeholder="' +
      placeholder +
      '"></textarea><div class="luxe-hint">Enter to queue &middot; ' +
      'Send from the Luxe conversation</div><div class="luxe-row"><button class="luxe-cancel" type="button">Cancel</button><button class="luxe-send" type="button">Queue</button></div>';
    root.appendChild(card);

    const left = Math.min(Math.max(12, rect.left), window.innerWidth - card.offsetWidth - 12);
    const top = Math.min(Math.max(12, rect.bottom + 8), window.innerHeight - card.offsetHeight - 12);
    card.style.left = left + "px";
    card.style.top = top + "px";

    const textarea = /** @type {HTMLTextAreaElement | null} */ (card.querySelector("textarea"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".luxe-cancel"));
    const sendButton = /** @type {HTMLButtonElement | null} */ (card.querySelector(".luxe-send"));
    if (!textarea || !cancelButton || !sendButton) return;

    cancelButton.onclick = closeCard;
    sendButton.onclick = () => {
      const prompt = textarea.value.trim();
      if (prompt) queuePrompt(prompt, { ...c, queueKey: "" });
      closeCard();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendButton.click();
      }
    });
    setTimeout(() => textarea.focus(), 0);
  }

  /** @type {Window & { luxe?: unknown }} */ (window).luxe = {
    queuePrompt,
    getQueuedPrompts: () => [],
    setStatus: (message) => parent.postMessage({ type: "luxe:status", message: String(message) }, "*"),
    snapshot,
  };

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.type === "luxe:setSessionEnded") setSessionEnded();
    else if (msg.type === "luxe:setAnnotationMode") setAnnotationMode(msg.enabled);
    // The chrome and this document cannot see each other's clicks (the iframe is
    // sandboxed without same-origin), so the chrome forwards clicks that land on
    // itself and we treat them the same as clicking the page backdrop.
    if (msg.type === "luxe:dismissAnnotationCard") dismissCard();
    if (msg.type === "luxe:requestSnapshot") {
      parent.postMessage({ type: "luxe:snapshot", snapshot: snapshot() }, "*");
    }
    if (msg.type === "luxe:restoreScroll") {
      window.scrollTo(Number(msg.x) || 0, Number(msg.y) || 0);
    }
  });

  // Capture phase so the mode hotkey fires no matter where focus is inside the artifact -
  // including a checkbox, button, link, or the annotation-card textarea - without disturbing
  // normal typing. This SDK doesn't own the mode state; it asks the chrome to toggle the same
  // state the on-screen switch drives, via the same postMessage protocol as setAnnotationMode.
  document.addEventListener(
    "keydown",
    (event) => {
      if (isModeToggleHotkeyEvent(event)) {
        event.preventDefault();
        parent.postMessage({ type: "luxe:toggleAnnotationMode" }, "*");
        return;
      }
      // Escape is the keyboard form of clicking away. It closes an empty card and
      // leaves a card carrying a draft alone, matching the click behaviour.
      if (event.key === "Escape" && cardIsOpen()) {
        if (dismissCard()) event.preventDefault();
      }
    },
    true,
  );

  // Report scroll position to the chrome so it can be restored across hot reloads.
  // The iframe is sandboxed without same-origin, so the chrome can't read scrollY directly.
  let scrollFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        parent.postMessage({ type: "luxe:scroll", x: window.scrollX, y: window.scrollY }, "*");
      });
    },
    { passive: true },
  );

  document.addEventListener(
    "mouseover",
    (event) => {
      if (!annotationMode || isLuxeUi(event.target) || isLuxeAction(event.target) || isInteractiveControl(event.target))
        return;
      const target = annotationTargetEl(event.target);
      if (target === selected) return;
      if (hovered && hovered !== selected) clearHighlight(hovered);
      hovered = target;
      highlightElement(hovered);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    () => {
      if (hovered && hovered !== selected) {
        clearHighlight(hovered);
        hovered = null;
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      if (!annotationMode || isLuxeUi(event.target) || isLuxeAction(event.target) || isInteractiveControl(event.target))
        return;

      const c = textSelectionContext(document.getSelection());
      if (!c) return;

      ignoreNextClick = true;
      showAnnotationCard(c.element, { context: c, range: c.range });
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!annotationMode || isLuxeUi(event.target) || isLuxeAction(event.target) || isInteractiveControl(event.target))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (ignoreNextClick) {
        ignoreNextClick = false;
        return;
      }
      // Clicking away from an OPEN card dismisses it. Full stop - it does not matter
      // what the click landed on.
      //
      // This used to be gated on `isPageBackdrop`, which only accepts <html> and <body>
      // themselves. In any artifact with a centred column - which is most of them - the
      // visually empty margins, the gaps between sections and the whole tail below the
      // content all hit-test to <main>, not <body>. So clicking obviously-empty space
      // opened a second card titled "Annotate <main>" instead of closing the first, and
      // worse, `showAnnotationCard` closes unconditionally and therefore threw away an
      // unsent draft that `dismissCard`'s guard exists to protect.
      //
      // `dismissCard` keeps that draft guard, so a card holding typed text still refuses
      // to go, and the click is simply spent.
      if (cardIsOpen()) {
        dismissCard();
        return;
      }
      // No card open: the backdrop is still not an annotation target, since a click on
      // <html> or <body> hit empty space rather than content.
      if (isPageBackdrop(event.target)) return;
      showAnnotationCard(event.target);
    },
    true,
  );

  // Injection 4 of 5 outside the shadow DOM, and the only one that is not about
  // annotation. Placed as the FIRST child of <head>, which is what makes the artifact
  // win: CSS layer priority follows the order layers are first DECLARED, and that
  // follows document position rather than the moment the node was inserted. The SDK
  // script sits before </body> and therefore runs after every artifact stylesheet has
  // been parsed, so appending this - the obvious thing to do, and what the other three
  // injections do - would make `luxe-baseline` the LAST declared layer and give it
  // priority over the artifact's own layers. Inserting first makes it the lowest.
  function injectArtifactBaseline() {
    if (!artifactBaselineCss) return;
    const root = document.documentElement;
    if (root?.getAttribute?.(baselineOptOutAttribute) === "off") return;
    // Already present because the author pasted the snippet `luxe design` prints. One
    // copy is the point; a second would be harmless but is still a second.
    if (document.getElementById(baselineStyleId)) return;
    const head = document.head;
    if (!head) return;
    const style = document.createElement("style");
    style.id = baselineStyleId;
    style.textContent = artifactBaselineCss;
    head.insertBefore(style, head.firstChild);
  }

  // The baseline can repair inline code and marks on a cocoa surface, but CSS cannot ask
  // "is the thing behind me dark?" - the stylesheet can only match DaisyUI's semantic
  // surface classes. An artifact that paints its own dark card leaves <mark> at the user
  // agent's yellow-on-black, which is exactly the case that prompted the fix.
  //
  // So measure it. This is still a repair and not a restyle: it fires only where the
  // surface really is dark, it only tags the ancestor so the existing rule applies, and it
  // touches nothing else. Cheap because the candidate set is tiny - marks and inline code,
  // not the document.
  function tagDarkSurfaces() {
    if (!artifactBaselineCss) return;
    const candidates = document.querySelectorAll("mark, code, kbd, samp");
    if (!candidates.length) return;
    const decided = new Map();
    for (const el of candidates) {
      if (el.closest("[data-luxe-ui]") || el.closest("pre")) continue;
      const surface = nearestPaintedAncestor(el);
      if (!surface || decided.has(surface)) continue;
      decided.set(surface, true);
      if (isDarkSurface(surface)) surface.setAttribute("data-luxe-on-dark", "");
    }
  }

  // The nearest ancestor that actually paints something. A transparent background means
  // whatever is behind it shows through, so it is not the surface this text sits on.
  function nearestPaintedAncestor(el) {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor;
      const parts = String(background).match(/[\d.]+/g);
      if (!parts) continue;
      const alpha = parts.length > 3 ? Number(parts[3]) : 1;
      if (alpha > 0.5) return node;
    }
    return null;
  }

  function isDarkSurface(node) {
    const parts = String(getComputedStyle(node).backgroundColor).match(/[\d.]+/g);
    if (!parts || parts.length < 3) return false;
    const [r, g, b] = parts.slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    // WCAG relative luminance. The threshold is where ivory text starts winning over ink
    // text on the same surface, so "dark" means "a light foreground belongs here".
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18;
  }

  injectArtifactBaseline();
  setAnnotationMode(annotationMode);
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        tagDarkSurfaces();
        startLayoutAudit();
      },
      { once: true },
    );
  } else {
    tagDarkSurfaces();
    startLayoutAudit();
  }

  // Mermaid renders asynchronously (and can re-render on theme/resize), so we
  // enhance on load, again shortly after, and whenever the DOM adds new SVGs.
  enhanceMermaid();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhanceMermaid, { once: true });
  }
  const mermaidObserver = new MutationObserver(() => scheduleMermaidEnhance());
  mermaidObserver.observe(document.documentElement, { childList: true, subtree: true });
}
