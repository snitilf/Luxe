/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("luxe-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "luxe:queued:" + key;
const internalQueueKeyField = "_luxeQueueKey";
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const MODE_TOGGLE_HOTKEY_KEY = String(sessionData.modeToggleHotkeyKey || "").toLowerCase();

function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const exportArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("exportArtifact"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const endedChip = /** @type {HTMLSpanElement} */ (document.getElementById("endedChip"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const layoutIssueBanner = /** @type {HTMLDivElement} */ (document.getElementById("layoutIssueBanner"));
const layoutIssueBannerText = /** @type {HTMLSpanElement} */ (document.getElementById("layoutIssueBannerText"));
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const defaultSendHintText = sendHint.textContent;
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const farewell = /** @type {HTMLDivElement} */ (document.getElementById("farewell"));
const farewellClose = /** @type {HTMLButtonElement} */ (document.getElementById("farewellClose"));
const farewellCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("farewellCopy"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
// Mode state lives here and nowhere else: the chrome owns annotate/explore and drives the
// artifact SDK over postMessage. The initial value comes from the session bootstrap the
// server emitted, which is the same value it rendered the switch's aria-pressed from, so the
// switch and the state can never disagree at load. Missing or malformed bootstrap falls back
// to explore mode, matching ANNOTATION_DEFAULT in server.js.
let annotation = sessionData.annotationDefault === true;
// Whether this session was already over when the page loaded. Kept separate from `ended`
// because the two mean different things at boot: `initialEnded` decides whether to stand the
// live machinery up at all, while `ended` tracks the running state from there on.
const initialEnded = sessionData.ended === true;
let ended = false;
let agentPresence = "waiting";
let pendingSnapshot = "";
let pendingSubmitPrompts = [];
let pointerdownSendFreeze = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let pointerdownSendFreezeTimer;
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let layoutGateVisible = false;
let layoutGateArmed = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
const snapshotRequests = [];
let endAfterSubmit = false;
// Whether an end initiated FROM THIS TAB is in flight, and therefore whether the session
// ending should be answered with a farewell.
//
// This exists because of an ordering that cannot be worked around at the call site: the
// server emits its `ended` SSE frame BEFORE it answers the POST that caused it
// (src/server.js, the prompts handler emits and then responds). So the stream listener
// always reaches markSessionEnded first, and the farewell-bearing call that follows the
// fetch response hits `if (ended) return` and does nothing. Recording the intent before
// the request goes out is what makes the two paths agree.
let farewellPending = false;
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let lastScroll = { x: 0, y: 0 };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;
// Who last wrote the send hint. Three writers share that one line - the empty-composer
// nudge, send status/errors, and the "agent is working" reason - and they have different
// priorities, so the line records its owner instead of being guessed at from its text.
/** @type {"nudge" | "status" | "working" | null} */
let sendHintOwner = null;
// The live event stream, held here rather than only in the const at the bottom of the
// file so `markSessionEnded` can close it without reaching into the boot section.
/** @type {EventSource | null} */
let eventStream = null;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((prompt) => prompt && typeof prompt === "object")
          .map((prompt) => normalizeQueuedPrompt(prompt, { preserveBrowserMetadata: true }))
      : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

// Queued and sending are told apart by the border treatment the component table
// specifies - dashed while queued, solid once in flight. There is deliberately no state
// glyph: a 24px outlined circle beside two lines of text competes with them for
// attention, and it is the "big circle" half of the reported noise.

// What to call a queued item, in three tiers.
//
// 1. The topic the artifact declared. Always the best answer, because the author knows
//    what the question was.
// 2. A `question:` queue key, de-prefixed and humanised. `deriveQueueKey` is a DEDUPE
//    key, not a label - its other branches produce `form:signup|radio:name` composites
//    and raw `div > form > fieldset` element paths, and printing either of those would
//    be worse than showing nothing. Only the branch that carries a real question name
//    is accepted.
// 3. The prompt itself, trimmed to a phrase. Never the bare tag: "Queue answered -
//    choice" is technically true and tells the reader nothing.
const TOPIC_MAX = 60;

function humanizeTopic(value) {
  const words = String(value).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function promptTopic(prompt) {
  const declared = typeof prompt?.topic === "string" ? prompt.topic.trim() : "";
  if (declared) return truncateTopic(declared);

  const key = promptQueueKey(prompt);
  // Composites and element paths are structure, not names.
  if (key.startsWith("question:") && !key.includes("|") && !key.includes(">")) {
    const humanized = humanizeTopic(key.slice("question:".length));
    if (humanized) return truncateTopic(humanized);
  }

  const body = String(prompt?.prompt || "").trim();
  if (body) return truncateTopic(body.split("\n")[0]);
  return "Feedback";
}

function truncateTopic(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > TOPIC_MAX ? text.slice(0, TOPIC_MAX - 1).trimEnd() + "…" : text;
}

// A queued pill names what is queued and gets out of the way.
//
// Upstream showed one ellipsized line and put the selector and the full prompt behind a
// hover tooltip. The port replaced that with a clock glyph, the raw CSS selector in mono,
// a tag chip and an expandable table of node paths and offsets, all on screen at once -
// which is the "big circle and all the code" Filip reported. This restores the restraint
// and keeps the disclosure, because hover-only content is unreachable by touch and by
// keyboard.
function promptDetail(body, topic) {
  if (!body || body === topic) return "";
  const lower = body.toLowerCase();
  const prefix = topic.replace(/…$/, "").toLowerCase();
  // A truncated topic IS this prompt, cut short - so there is no second line to show.
  // Checked before the prefix strip below, which would otherwise hand back the tail of a
  // word: topic "…keep w…" over body "…keep writes up." leaves "rites up."
  if (topic.endsWith("…") && lower.startsWith(prefix)) return "";
  if (prefix && lower.startsWith(prefix)) {
    return body.slice(prefix.length).replace(/^\s*[:\-\u2013\u2014]?\s*/, "");
  }
  return body;
}

function promptInlineHtml(prompt) {
  const topic = promptTopic(prompt);
  // Only worth a second line when it says something the topic did not. An artifact that
  // sets topic "Rollback window" and prompt "Rollback window: 30 days" was printing the
  // topic twice, which reads like debug output - so the redundant prefix is stripped and
  // what remains is the answer alone.
  const detail = promptDetail(String(prompt.prompt || "").trim(), topic);
  return (
    '<div class="pill-topic">' +
    escapeHtml(topic) +
    "</div>" +
    (detail ? '<div class="pill-detail">' + escapeHtml(detail) + "</div>" : "")
  );
}

function targetFieldHtml(label, value) {
  return "<div><dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(value === "" ? "(empty)" : value) + "</dd></div>";
}

// Everything the pill face no longer shows. The selector, the quoted source text and the
// tag are here rather than on screen: they are how an agent locates the target, not how a
// reviewer recognises their own question, and they were the bulk of the noise.
function promptDisclosureHtml(prompt) {
  const rows = [];
  if (prompt.tag) rows.push(["Kind", prompt.tag]);
  if (prompt.text) rows.push(["Text", prompt.text]);
  if (prompt.selector) rows.push(["Selector", prompt.selector]);
  const target = prompt.target;
  if (target) rows.push(...targetRows(target));
  if (!rows.length) return "";
  return (
    '<details class="pill-target-details"><summary>Details</summary><dl>' +
    rows.map(([label, value]) => targetFieldHtml(label, value)).join("") +
    "</dl></details>"
  );
}

function targetRows(target) {
  const rows = [["Type", target.type]];
  if (target.type === "mermaid-node") {
    rows.push(
      ["Diagram ID", target.diagramId],
      ["Node ID", target.nodeId],
      ["Label", target.label],
      ["Selector", target.selector],
    );
  } else if (target.type === "text-range") {
    rows.push(
      ["Text", target.text],
      ["Selector", target.selector],
      ["Start selector", target.start.selector],
      ["Start path", "[" + target.start.path.join(", ") + "]"],
      ["Start offset", target.start.offset],
      ["End selector", target.end.selector],
      ["End path", "[" + target.end.path.join(", ") + "]"],
      ["End offset", target.end.offset],
    );
  } else if (target.type === "excalidraw-scene") {
    rows.push(
      ["Diagram index", target.diagramIndex],
      ["Diagram ID", target.diagramId],
      ["Source hash", target.sourceHash],
      ["Scene path", target.scenePath],
      ["Preview path", target.previewPath],
      ["Image fallback", String(target.imageFallback)],
      ["Added", target.stats.added],
      ["Removed", target.stats.removed],
      ["Moved", target.stats.moved],
      ["Relabeled", target.stats.relabeled],
      ["Drawn", target.stats.drawn],
    );
  }
  return rows;
}

function render() {
  const sending = Boolean(submitQueuedPromise);
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill' +
        (sending ? " sent" : "") +
        '"><div class="pill-fields">' +
        promptInlineHtml(prompt) +
        '</div><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button></div>' +
        promptDisclosureHtml(prompt) +
        (prompt._luxeQueueError ? '<div class="pill-error">' + escapeHtml(prompt._luxeQueueError) + "</div>" : "") +
        "</div>",
    )
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
}

const WORKING_SEND_REASON = "Waiting for the agent to finish before sending.";

// Both send buttons are disabled while the agent is working, which is deliberate - but it
// used to give no reason at all, so the UI simply stopped responding and the reviewer was
// left to guess. The reason goes on `title` for a pointer, on `aria-describedby` (wired in
// the markup) for a screen reader, and into the existing live region so it is visible
// without hovering anything.
function updateSendState() {
  const waitingOnAgent = !ended && agentPresence === "working";
  sendButton.disabled = ended || waitingOnAgent;
  sendAndEndButton.disabled = sendButton.disabled;

  const reason = waitingOnAgent ? WORKING_SEND_REASON : "";
  for (const button of [sendButton, sendAndEndButton]) {
    if (reason) button.title = reason;
    else button.removeAttribute("title");
  }

  // The hint is shared with the empty-composer nudge and with send errors, and those
  // matter more than explaining a greyed button. Ownership is tracked explicitly rather
  // than inferred from `hidden` or from the current text: both are things another writer
  // can change, which would let this quietly stop showing - or, worse, let it overwrite
  // a failure the reviewer still needs to read.
  if (waitingOnAgent && (sendHintOwner === null || sendHintOwner === "working")) {
    clearTimeout(sendHintTimer);
    sendHint.textContent = WORKING_SEND_REASON;
    sendHint.hidden = false;
    sendHintOwner = "working";
  } else if (!waitingOnAgent && sendHintOwner === "working") {
    sendHint.hidden = true;
    sendHintOwner = null;
  }
}

function showSendHint() {
  sendHint.textContent = defaultSendHintText;
  sendHint.hidden = false;
  sendHintOwner = "nudge";
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
    sendHintOwner = null;
  }, 2600);
  chatInput.focus();
}

function showSendStatus(text) {
  clearTimeout(sendHintTimer);
  sendHint.textContent = text;
  sendHint.hidden = false;
  sendHintOwner = "status";
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
  sendHintOwner = null;
}

function setMenuOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

// A receipt is not a message. It records that a queued item was delivered, so it gets a
// quiet one-line treatment rather than a speech bubble with a "YOU" label - the reviewer
// did not say "Queue answered - Billing plan", Luxe did.
function addChat(role, text, shouldScroll = true, kind = "") {
  if (!text) return;

  const el = document.createElement("div");
  if (kind === "receipt") {
    el.className = "chat-receipt";
    el.innerHTML = '<span class="chat-receipt-mark" aria-hidden="true"></span><span>' + escapeHtml(text) + "</span>";
  } else {
    el.className = "bubble " + role;
    el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  }
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working),.chat-receipt")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false, item.kind) || lastChatBubble;
  if (workingBubble) {
    chatLog.appendChild(workingBubble);
    scrollElementIntoView(workingBubble);
  } else if (lastChatBubble) {
    scrollElementIntoView(lastChatBubble);
  }
}

// Presence is a live-session concept. Once the session ends there is no agent to be
// listening or working, so an ended session refuses every further presence update: the
// SSE stream is closed on end, but a message already in flight would otherwise resurrect
// the working spinner on a dead session, which is what the old code did.
function setAgentPresence(state) {
  if (ended) return;
  agentPresence = state === "listening" || state === "working" ? state : "waiting";
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  if (agentPresence !== "working") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
  }
  scrollElementIntoView(workingBubble);
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function boundedQueueInteger(value, max = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), max);
}

function normalizeQueueAnchor(anchor) {
  return {
    selector: String(anchor?.selector || ""),
    path: Array.isArray(anchor?.path)
      ? Array.from(anchor.path, (segment) => boundedQueueInteger(segment, Number.MAX_SAFE_INTEGER))
      : [],
    offset: boundedQueueInteger(anchor?.offset, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeQueueTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") {
    return {
      type: "mermaid-node",
      diagramId: String(target.diagramId || ""),
      nodeId: String(target.nodeId || ""),
      label: String(target.label || ""),
      selector: String(target.selector || ""),
    };
  }
  if (target.type === "text-range") {
    return {
      type: "text-range",
      text: String(target.text || ""),
      selector: String(target.selector || ""),
      start: normalizeQueueAnchor(target.start),
      end: normalizeQueueAnchor(target.end),
    };
  }
  if (target.type === "excalidraw-scene") {
    const stats = target.stats && typeof target.stats === "object" && !Array.isArray(target.stats) ? target.stats : {};
    return {
      type: "excalidraw-scene",
      diagramIndex: boundedQueueInteger(target.diagramIndex, 999),
      diagramId: String(target.diagramId || ""),
      sourceHash: String(target.sourceHash || ""),
      scenePath: String(target.scenePath || ""),
      previewPath: String(target.previewPath || ""),
      imageFallback: Boolean(target.imageFallback),
      stats: {
        added: boundedQueueInteger(stats.added),
        removed: boundedQueueInteger(stats.removed),
        moved: boundedQueueInteger(stats.moved),
        relabeled: boundedQueueInteger(stats.relabeled),
        drawn: boundedQueueInteger(stats.drawn),
      },
    };
  }
  return null;
}

function normalizeQueuedPrompt(prompt, { preserveBrowserMetadata = false } = {}) {
  const normalized = {
    prompt: String(prompt?.prompt || ""),
    text: String(prompt?.text || ""),
    selector: String(prompt?.selector || ""),
    tag: String(prompt?.tag || ""),
  };
  // Bounded here as well as in the SDK: this path also loads prompts back out of
  // sessionStorage, which anything running in the page could have written to. Omitted
  // when absent so a prompt without a topic keeps the shape it has always had.
  const topic = String(prompt?.topic || "").slice(0, 80);
  if (topic) normalized.topic = topic;
  const target = normalizeQueueTarget(prompt?.target);
  if (target) normalized.target = target;
  const queueKey = promptQueueKey(prompt);
  if (queueKey) normalized[internalQueueKeyField] = queueKey;
  if (preserveBrowserMetadata && typeof prompt?._luxeQueueError === "string" && prompt._luxeQueueError) {
    normalized._luxeQueueError = prompt._luxeQueueError;
  }
  return normalized;
}

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

  const normalized = normalizeQueuedPrompt(prompt);
  const queueKey = promptQueueKey(normalized);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = normalized;
    } else {
      queued.push(normalized);
    }
  } else {
    queued.push(normalized);
  }

  persistQueuedPrompts();
  render();
}

function stripInternalPromptFields(prompt) {
  const normalized = normalizeQueuedPrompt(prompt);
  const clean = {
    prompt: normalized.prompt,
    text: normalized.text,
    selector: normalized.selector,
    tag: normalized.tag,
  };
  // Omitted rather than sent empty, like target: every field on the wire is one the
  // reviewer confirmed, and an always-present "" is noise in the payload the agent reads.
  if (normalized.topic) clean.topic = normalized.topic;
  if (normalized.target) clean.target = normalized.target;
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

// Clicking away from an open annotation card should dismiss it, but the card lives
// inside the sandboxed artifact frame and this document never sees clicks that land
// there (and vice versa). The frame handles its own backdrop clicks; the chrome
// forwards its own, so clicking the conversation panel, the toolbar, or the composer
// puts the card away. The frame ignores this while the card holds an unsent draft.
document.addEventListener(
  "pointerdown",
  (event) => {
    clearPointerdownSendFreeze();
    const endAfter = sendIntentForTarget(event.target);
    if (endAfter !== null && !ended && agentPresence !== "working") {
      pointerdownSendFreeze = freezeDisplayedBatch(endAfter);
      pointerdownSendFreezeTimer = setTimeout(clearPointerdownSendFreeze, 5_000);
    }
    postToFrame({ type: "luxe:dismissAnnotationCard" });
  },
  true,
);

document.addEventListener(
  "pointerup",
  () => {
    if (!pointerdownSendFreeze) return;
    clearTimeout(pointerdownSendFreezeTimer);
    pointerdownSendFreezeTimer = setTimeout(clearPointerdownSendFreeze, 0);
  },
  true,
);

document.addEventListener("pointercancel", clearPointerdownSendFreeze, true);

function sendIntentForTarget(target) {
  if (target === sendButton || sendButton.contains?.(target)) return false;
  if (target === sendAndEndButton || sendAndEndButton.contains?.(target)) return true;
  return null;
}

function freezeDisplayedBatch(endAfter) {
  return {
    endAfter,
    prompts: queued.slice(),
    composerText: chatInput.value.trim(),
  };
}

function clearPointerdownSendFreeze() {
  clearTimeout(pointerdownSendFreezeTimer);
  pointerdownSendFreezeTimer = undefined;
  pointerdownSendFreeze = null;
}

function consumeSendFreeze(endAfter) {
  const frozen =
    pointerdownSendFreeze && pointerdownSendFreeze.endAfter === endAfter
      ? pointerdownSendFreeze
      : freezeDisplayedBatch(endAfter);
  clearPointerdownSendFreeze();
  return frozen;
}

// Snapshot-request ledger, half one. Artifact JS can postMessage to its parent whenever it
// likes, so a `luxe:snapshot` message arriving is not evidence that the chrome asked for one.
// Every chrome-owned Send or Send & End gesture records the exact prompt batch it authorizes;
// the handler below consumes exactly one entry per snapshot it accepts and drops anything it
// did not ask for. Artifact messages can fill the queue, but cannot create or expand a send.
function requestSnapshot(prompts, endAfter) {
  snapshotRequests.push({ prompts, endAfter });
  postToFrame({ type: "luxe:requestSnapshot" });
}

function sendQueued(endAfter) {
  if (ended || agentPresence === "working") return;
  closeMenus();
  if (endAfter) farewellPending = true;

  const frozen = consumeSendFreeze(endAfter);
  const text = frozen.composerText;
  if (text) {
    const composerPrompt = normalizeQueuedPrompt({
      prompt: text,
      selector: "",
      tag: "message",
      text: "Freeform message",
    });
    queued.push(composerPrompt);
    frozen.prompts.push(composerPrompt);
    persistQueuedPrompts();
    addChat("user", text);
    if (chatInput.value.trim() === text) chatInput.value = "";
    render();
  }
  if (!frozen.prompts.length) {
    showSendHint();
    return;
  }
  hideSendHint();

  requestSnapshot(frozen.prompts, endAfter);
}

async function submitQueued() {
  if (submitQueuedPromise) {
    submitQueuedAgain = true;
    return submitQueuedPromise;
  }

  let succeeded = false;
  submitQueuedPromise = submitQueuedOnce();
  render(); // repaint the queued pills in their sent treatment
  try {
    const result = await submitQueuedPromise;
    succeeded = true;
    return result;
  } catch (error) {
    showSendStatus(error instanceof Error ? error.message : "Feedback was not sent. Please try again.");
  } finally {
    submitQueuedPromise = null;
    render();
    const shouldSubmitAgain = submitQueuedAgain;
    submitQueuedAgain = false;
    if (!succeeded) {
      endAfterSubmit = false;
    } else if (!ended && shouldSubmitAgain) {
      if (queued.length) {
        submitQueued();
      } else if (endAfterSubmit) {
        endAfterSubmit = false;
        endSession({ farewell: true });
      }
    }
  }
}

async function submitQueuedOnce() {
  const prompts = pendingSubmitPrompts;
  const shouldEndSession = endAfterSubmit;
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot };
  if (shouldEndSession) body.endSession = true;
  const response = await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 413
        ? "Feedback was not sent - the batch or page snapshot exceeds Luxe's limits."
        : "Feedback was not sent - the request is invalid.",
    );
  }
  const result =
    typeof response.json === "function"
      ? await response.json()
      : {
          status: "queued",
          accepted_prompt_indices: prompts.map((_, index) => index),
          rejected_prompts: [],
          session_ended: shouldEndSession,
        };
  const acceptedIndices = new Set(
    Array.isArray(result.accepted_prompt_indices)
      ? result.accepted_prompt_indices.filter(
          (index) => Number.isInteger(index) && index >= 0 && index < prompts.length,
        )
      : prompts.map((_, index) => index),
  );
  const rejectedByIndex = new Map(
    Array.isArray(result.rejected_prompts)
      ? result.rejected_prompts
          .filter((rejection) =>
            ["invalid_whiteboard_target", "invalid_prompt", "prompt_too_large"].includes(rejection?.code),
          )
          .map((rejection) => [rejection.index, rejection.code])
      : [],
  );
  for (const [promptIndex, prompt] of prompts.entries()) {
    const index = queued.indexOf(prompt);
    if (acceptedIndices.has(promptIndex)) {
      if (index !== -1) queued.splice(index, 1);
    } else if (rejectedByIndex.has(promptIndex)) {
      const rejectedPrompt = {
        ...prompt,
        _luxeQueueError:
          rejectedByIndex.get(promptIndex) === "invalid_whiteboard_target"
            ? "Not sent - this whiteboard target is not a Luxe session file. Remove this item before sending again."
            : rejectedByIndex.get(promptIndex) === "prompt_too_large"
              ? "Not sent - this feedback item exceeds Luxe's limits. Remove or shorten it before sending again."
              : "Not sent - this feedback item is invalid. Remove it before sending again.",
      };
      if (index !== -1) {
        queued[index] = rejectedPrompt;
      } else {
        delete rejectedPrompt[internalQueueKeyField];
        queued.push(rejectedPrompt);
      }
    }
  }
  persistQueuedPrompts();
  render();
  if (shouldEndSession && rejectedByIndex.size > 0) {
    showSendStatus(
      acceptedIndices.size > 0
        ? "Valid feedback sent. Session not ended - remove the rejected item before sending again."
        : "Nothing sent. Session not ended - remove the rejected item before sending again.",
    );
  }
  if (shouldEndSession && result.session_ended === true) {
    endAfterSubmit = false;
    markSessionEnded({ farewell: true });
    return;
  }
  if (acceptedIndices.size > 0 && agentPresence === "listening") setAgentPresence("working");
}

function normalizeLayoutWarningsPayload(value) {
  const kinds = new Set([
    "page-horizontal-overflow",
    "clipped-text",
    "viewport-unreachable-content",
    "clipped-control",
    "viewport-unreachable-control",
    "overlapping-text",
  ]);
  const segment = "[a-z][a-z0-9-]*(#[A-Za-z_][A-Za-z0-9_-]{0,127})?(:nth-of-type\\([1-9][0-9]{0,5}\\))?";
  const selectorPattern = new RegExp(`^${segment}( > ${segment}){0,4}$`);
  if (!Array.isArray(value) || value.length > 50) return null;
  const normalized = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (typeof item.selector !== "string" || item.selector.length > 512 || !selectorPattern.test(item.selector)) {
      return null;
    }
    if (!kinds.has(item.kind) || item.severity !== "error") return null;
    if (item.axis !== "horizontal" && item.axis !== "vertical") return null;
    if (typeof item.overflowPx !== "number" || !Number.isFinite(item.overflowPx) || item.overflowPx < 0) return null;
    normalized.push({
      selector: item.selector,
      kind: item.kind,
      severity: "error",
      axis: item.axis,
      overflowPx: item.overflowPx,
    });
  }
  return normalized;
}

function isErrorLayoutWarning(warning) {
  return warning?.severity === "error";
}

function setLayoutIssueBanner(visible, text = "Luxe received a reported warning. Your agent has been notified.") {
  if (!layoutIssueBanner) return;
  // Write into the label span, never the banner itself: the banner's first
  // child is the 20px alert icon, and status ships as icon plus label (spec
  // 2.6). Setting textContent on the banner would delete the icon at boot.
  if (layoutIssueBannerText) layoutIssueBannerText.textContent = text;
  layoutIssueBanner.hidden = !visible;
}

function clearLayoutGateTimer() {
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "Luxe received a reported warning. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Luxe is waiting for fonts and final geometry before revealing this artifact.";
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

function revealLayoutGate({ showBanner = false, bannerText = undefined } = {}) {
  clearLayoutGateTimer();
  layoutGateArmed = false;
  setLayoutGateActive(false);
  setLayoutIssueBanner(showBanner, bannerText);
}

function forceRevealLayoutGate(reason) {
  if (!layoutGateEnabled || ended) return;
  if (reason === "timeout") {
    // A delayed or unavailable audit is uncertainty, not evidence of a defect.
    revealLayoutGate();
    return;
  }
  if (reason === "manual") layoutGateManuallyBypassed = true;
  revealLayoutGate({
    showBanner: true,
    bannerText: "Luxe received a reported warning. You chose to show the artifact before the layout check passed.",
  });
}

function startLayoutGateCycle() {
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  layoutGateArmed = true;
  setLayoutIssueBanner(false);
  setLayoutGateCard("checking");
  setLayoutGateActive(true);
  clearLayoutGateTimer();

  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

function handleLayoutWarningsForGate(layoutWarnings) {
  const warnings = normalizeLayoutWarningsPayload(layoutWarnings);
  if (warnings === null) return;
  const hasErrors = warnings.some(isErrorLayoutWarning);

  if (!layoutGateEnabled) return;

  if (layoutGateManuallyBypassed) {
    setLayoutIssueBanner(hasErrors);
    return;
  }

  if (!layoutGateArmed && !layoutGateVisible) return;

  if (!hasErrors) {
    revealLayoutGate();
    return;
  }

  clearLayoutGateTimer();
  setLayoutGateCard("held");
  setLayoutGateActive(true);
}

function initializeLayoutGate() {
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    setLayoutIssueBanner(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  startLayoutGateCycle();
}

async function submitLayoutWarnings(layoutWarnings) {
  const normalized = normalizeLayoutWarningsPayload(layoutWarnings);
  if (normalized === null) return;
  const response = await fetch("/api/" + key + "/layout-warnings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout_warnings: normalized }),
  });
  if (!response.ok) throw new Error("failed to submit layout warnings");
}

async function endSession({ farewell: showGoodbye = false } = {}) {
  if (ended) return;
  if (showGoodbye) farewellPending = true;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded({ farewell: showGoodbye });
}

// Remove the "Working..." bubble directly. Routing this through setAgentPresence("waiting")
// would work by side effect, but "waiting" means "your agent is not listening" - a live-session
// state with its own banner - so an ended session would pass through a status it can never be in.
function clearWorkingIndicator() {
  if (workingBubble) workingBubble.remove();
  workingBubble = null;
  agentPresence = "waiting";
}

function closeEventStream() {
  if (!eventStream) return;
  eventStream.close();
  eventStream = null;
}

// Every timer that can still fire after the session is over. None of them are harmful on
// their own; together they are the difference between a page that has stopped and a page
// that merely looks stopped.
function clearSessionTimers() {
  clearTimeout(sendHintTimer);
  sendHintTimer = undefined;
  clearTimeout(copyHintTimer);
  copyHintTimer = undefined;
  clearLayoutGateTimer();
  clearPointerdownSendFreeze();
}

// The goodbye, and the honest half of "close the page".
//
// window.close() only works on a tab that script opened. Luxe hands the URL to the `open`
// package, so in every ordinary session the tab is user-opened and the call is refused
// silently. That makes the card the deliverable and the close attempt the bonus - not the
// other way round - so the card says what to do when the browser declines.
//
// Shown when the reviewer ends the session from this tab - Send & End, or End session in
// the overflow menu - and not when it ended some other way: the agent running `luxe end`,
// or a reload of a session that was already over. A farewell answers a goodbye; popping
// one over a page nobody just said goodbye on is a jump scare.
function showFarewell() {
  if (!farewell) return;
  farewell.hidden = false;
  farewellClose?.focus?.();
  attemptTabClose();
}

// Try to close, and when the browser refuses, say so instead of leaving a button that
// visibly does nothing. window.close() only works on a tab that script opened, and Luxe
// hands the URL to the `open` package, so in an ordinary session the refusal is the
// normal outcome - it is silent, there is no error to catch, and the tab simply stays.
function attemptTabClose() {
  try {
    window.close();
  } catch {
    // Refused. Handled below by the fact that the window is still here.
  }
  // If the close had worked, nothing after this runs. Since it usually does not, swap the
  // button for the keystroke that actually closes a tab the reader opened themselves.
  setTimeout(() => {
    if (!farewellClose || farewellClose.hidden) return;
    farewellClose.hidden = true;
    if (farewellCopy) {
      farewellCopy.textContent = isApplePlatform()
        ? "Your feedback is on its way. Press \u2318W to close this tab."
        : "Your feedback is on its way. Press Ctrl+W to close this tab.";
    }
  }, 120);
}

function isApplePlatform() {
  // userAgentData is the modern source and is not in the DOM lib typings, hence the cast.
  const data = /** @type {any} */ (navigator).userAgentData;
  const platform = String(data?.platform || navigator.platform || navigator.userAgent || "");
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function markSessionEnded({ farewell: showGoodbye = farewellPending } = {}) {
  if (ended) return;
  ended = true;
  closeMenus();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = true;

  // Tear the live-session machinery down rather than merely hiding it. Leaving any of
  // this running is what made an ended session keep claiming to be working: the spinner
  // is owned by presence, presence is fed by the stream, and the stream outlived the
  // session. Order matters only in that the stream closes before the last repaint.
  clearWorkingIndicator();
  closeEventStream();
  clearSessionTimers();
  layoutGateManuallyBypassed = true;
  revealLayoutGate();
  // Not `luxe:setAnnotationMode`. The SDK computes the whiteboard affordance's disabled state
  // as `busy || annotationMode`, so telling the artifact that annotation is off would ENABLE
  // "Edit as whiteboard" on a session that is over. Ending is its own terminal state, and the
  // SDK cannot leave it.
  postToFrame({ type: "luxe:setSessionEnded" });
  // The ended state is a change of interaction model, not a curtain: the chrome
  // recedes to 45%, drops the annotation hue (body.session-ended maps --gold to
  // --strong) and stops accepting input, while the artifact stays readable.
  document.body?.classList?.add("session-ended");
  endedChip.hidden = false;
  if (showGoodbye) showFarewell();
}

function copyFilePath() {
  copyText(filePath);
  copyHint.classList.add("copied");
  copyHintText.textContent = "Copied";
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = "Copy";
  }, 1600);
}

function exportFileName() {
  const base = (filePath.split(/[\\/]/).pop() || "artifact.html").replace(/\.html?$/i, "");
  return (base || "artifact") + ".export.html";
}

function setExportLabel(text) {
  const label = exportArtifactButton.querySelector("span");
  if (label) label.textContent = text;
}

function unresolvedAssetText(count) {
  return count === 1 ? "1 unresolved asset" : `${count} unresolved assets`;
}

function noticeText(count) {
  return count === 1 ? "1 notice" : `${count} notices`;
}

function exportWarningText(unresolvedCount, noticeCount) {
  if (unresolvedCount > 0 && noticeCount > 0) {
    return `${unresolvedAssetText(unresolvedCount)} and ${noticeText(noticeCount)}`;
  }
  if (unresolvedCount > 0) return unresolvedAssetText(unresolvedCount);
  return noticeText(noticeCount);
}

async function exportArtifact() {
  // The bundle inlines local assets server-side, so it can take a moment - keep the menu open
  // and narrate progress in place instead of closing it and leaving the user with no feedback.
  exportArtifactButton.disabled = true;
  setExportLabel("Exporting...");
  try {
    const response = await fetch("/api/" + key + "/export");
    if (!response.ok) throw new Error("export failed");
    const warningCount = Number(response.headers.get("x-luxe-export-warning-count") || "0");
    const noticeCount = Number(response.headers.get("x-luxe-export-notice-count") || "0");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (warningCount > 0 || noticeCount > 0) {
      setExportLabel(`Exported with ${exportWarningText(warningCount, noticeCount)}`);
    } else {
      setExportLabel("Export standalone HTML");
      closeMenus();
    }
  } catch {
    setExportLabel("Export failed - retry");
  } finally {
    exportArtifactButton.disabled = false;
  }
}

function replaceArtifactFrame() {
  startLayoutGateCycle();
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  frame.src = artifactSrc || frame.src;
}

// A live reload replaces the artifact document. Nothing editable lives inside
// it any more - the only editor is the overlay, which sits outside the iframe
// and survives - so the reload is unconditional, and the open whiteboard is
// told about the new source separately (refreshWhiteboardSource).
function resetFrame() {
  replaceArtifactFrame();
  return Promise.resolve(true);
}

// ---------------------------------------------------------------------------
// Whiteboards, fullscreen-first. A rendered Mermaid diagram stays a rendered
// Mermaid diagram in the artifact; the artifact SDK draws one quiet Edit
// affordance over it, and pressing it asks the chrome to open that diagram in
// the full-viewport overlay. There is exactly one editor at a time, so nothing
// can race another editor onto the same sidecar.
//
// TRUST BOUNDARY. Upstream's maximize request arrived over the inline frame's
// authenticated channel: a signed token minted by the server, verified at
// POST /api/:key/whiteboard-channel. There is no inline frame any more, so the
// request now arrives from the artifact iframe, which is untrusted content -
// this is a deliberate change of who may ask, and it is guarded rather than
// assumed:
//
//   1. Only the artifact iframe's own window may ask. `event.source` must be
//      `frame.contentWindow`, the same gate every other artifact-to-chrome
//      message already passes (`luxe:queuePrompt`, `luxe:toggleAnnotationMode`),
//      so the new message adds no reach the artifact did not already have.
//   2. Asking conveys no data and writes nothing. The message carries a single
//      integer, which is range-checked here and then checked again against the
//      Mermaid sources the SERVER extracted from the artifact file on disk. An
//      index the artifact invented resolves to nothing and the open fails.
//   3. Authority to write still comes from the channel token, not from the ask.
//      The overlay frame the chrome opens is served a fresh signed token, POSTs
//      it to the same-origin-guarded channel route, and only after that does
//      the chrome accept a save, a queue, or a save-to-machine from it. A page
//      that spammed opens would move the UI around; it could not persist a byte.
//   4. One at a time, and never after the session ends.
// ---------------------------------------------------------------------------

/** @type {Map<number, { diagramId: string, source: string, sourceHash: string }>} */
const whiteboards = new Map();
/** @type {number | null} */
let overlayIndex = null;
let overlayFrameReady = false;
let overlayChannelId = "";
let overlayOpeningIndex = null;
let nextWhiteboardFlushId = 0;
let chromeRestartReloadPromise = null;
const whiteboardTeardowns = new Map();
const whiteboardFlushes = new Map();
const whiteboardSaveChains = new Map();

function postToWhiteboard(message) {
  if (whiteboardFrame.contentWindow && overlayChannelId) {
    whiteboardFrame.contentWindow.postMessage({ ...message, channelId: overlayChannelId }, "*");
  }
}

async function fetchMermaidSources() {
  const response = await fetch("/api/" + key + "/mermaid-sources");
  if (!response.ok) throw new Error("could not read the artifact's Mermaid sources");
  const data = await response.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

async function authenticateWhiteboardChannel(token) {
  const response = await fetch("/api/" + key + "/whiteboard-channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

function showWhiteboardError(text) {
  whiteboardError.textContent = text;
  whiteboardError.hidden = false;
  whiteboardOverlay.hidden = false;
}

function whiteboardRecord(index) {
  let record = whiteboards.get(index);
  if (!record) {
    record = { diagramId: "", source: "", sourceHash: "" };
    whiteboards.set(index, record);
  }
  return record;
}

async function handleWhiteboardReady(index, isCurrent) {
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    if (!source) throw new Error("this diagram's Mermaid source was not found in the artifact file");
    const savedResponse = await fetch("/api/" + key + "/whiteboard/" + index);
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    const record = whiteboardRecord(index);
    record.source = String(source.source || "");
    record.sourceHash = String(source.hash || "");
    if (!isCurrent()) return false;
    postToWhiteboard({
      type: "luxe-whiteboard:init",
      diagramIndex: index,
      diagramId: record.diagramId,
      source: record.source,
      sourceHash: record.sourceHash,
      saved,
    });
    return true;
  } catch (error) {
    showWhiteboardError("Could not open the whiteboard: " + (error instanceof Error ? error.message : String(error)));
    return false;
  }
}

function showWhiteboardOverlay(index) {
  if (ended) return;
  overlayIndex = index;
  overlayFrameReady = false;
  overlayChannelId = "";
  whiteboardError.hidden = true;
  whiteboardOverlay.hidden = false;
  postToFrame({ type: "luxe:whiteboardOpened", diagramIndex: index });
  // A fresh document per open: the frame boots, posts ready, and receives its
  // init - no stale editor state can leak between opens.
  whiteboardFrame.src = "/whiteboard-frame?diagramIndex=" + encodeURIComponent(String(index));
}

function finishWhiteboardClose(index) {
  whiteboardOverlay.hidden = true;
  whiteboardError.hidden = true;
  whiteboardFrame.src = "about:blank";
  overlayIndex = null;
  overlayFrameReady = false;
  overlayChannelId = "";
  if (!ended) postToFrame({ type: "luxe:whiteboardClosed", diagramIndex: index });
}

// Save-before-close. The overlay never closes on the strength of its own
// bookkeeping: it asks the frame to flush, and only a confirmed save tears the
// editor down. A failed save leaves the whiteboard open with the error visible,
// which is the whole point - closing anyway would drop the edits.
function beginWhiteboardTeardown(index, onComplete) {
  const pending = whiteboardTeardowns.get(index);
  if (pending) {
    if (onComplete) pending.promise.then(onComplete);
    return pending.promise;
  }
  const flushId = `whiteboard-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardTeardowns.set(index, { index, flushId, promise, resolve, onComplete });
  postToWhiteboard({ type: "luxe-whiteboard:prepareTeardown", flushId });
  return promise;
}

function settleWhiteboardTeardown(index, message, ok) {
  const flushId = String(message.flushId || "");
  const teardown = whiteboardTeardowns.get(index);
  if (!teardown || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(index);
  teardown.onComplete?.(ok);
  teardown.resolve(ok);
}

function beginWhiteboardFlush(index) {
  const pending = whiteboardFlushes.get(index);
  if (pending) return pending.promise;
  const flushId = `whiteboard-flush-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardFlushes.set(index, { index, flushId, promise, resolve });
  postToWhiteboard({ type: "luxe-whiteboard:flush", flushId });
  return promise;
}

function finishWhiteboardFlush(index, message) {
  const flushId = String(message.flushId || "");
  const flush = whiteboardFlushes.get(index);
  if (!flush || flush.flushId !== flushId) return;
  whiteboardFlushes.delete(index);
  flush.resolve(Boolean(message.ok));
}

// A version-driven chrome reload replaces this whole document, so an open
// whiteboard gets a bounded chance to save first. Bounded, not unbounded: a
// wedged frame must not block the upgrade forever.
async function flushWhiteboardsBeforeChromeReload() {
  if (overlayIndex === null || !overlayFrameReady) return;
  let timeout;
  await Promise.race([
    beginWhiteboardFlush(overlayIndex),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 1500);
    }),
  ]);
  clearTimeout(timeout);
}

// The guarded entry point for the artifact's Edit affordance. See the trust
// boundary note at the top of this section: the index is range-checked here and
// resolved against the server's own extraction of the artifact file before any
// editor appears.
async function openWhiteboardOverlay(index) {
  if (ended || overlayIndex !== null || overlayOpeningIndex !== null) return;
  overlayOpeningIndex = index;
  try {
    const sources = await fetchMermaidSources();
    if (!sources.some((item) => item.index === index)) {
      showWhiteboardError("That diagram is not in the artifact file any more. Reload and try again.");
      return;
    }
    if (overlayOpeningIndex !== index || ended || overlayIndex !== null) return;
    showWhiteboardOverlay(index);
  } catch (error) {
    showWhiteboardError("Could not open the whiteboard: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    if (overlayOpeningIndex === index) overlayOpeningIndex = null;
  }
}

function closeWhiteboard() {
  const index = overlayIndex;
  if (index === null) return;
  if (!overlayFrameReady) {
    finishWhiteboardClose(index);
    return;
  }
  beginWhiteboardTeardown(index, (flushed) => {
    if (flushed && overlayIndex === index) finishWhiteboardClose(index);
  });
}

async function persistWhiteboardScene(index, message) {
  const response = await fetch("/api/" + key + "/whiteboard/" + index, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_hash: String(message.sourceHash || ""),
      text_metrics_version: Number(message.textMetricsVersion) || 0,
      scene: message.scene || null,
      baseline: message.baseline || null,
    }),
  });
  if (!response.ok) throw new Error("failed to save whiteboard scene");
}

function saveWhiteboardScene(index, message) {
  const previous = whiteboardSaveChains.get(index) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => persistWhiteboardScene(index, message));
  const tail = result.catch(() => {});
  whiteboardSaveChains.set(index, tail);
  tail.finally(() => {
    if (whiteboardSaveChains.get(index) === tail) whiteboardSaveChains.delete(index);
  });
  return result;
}

function handleWhiteboardSave(index, message) {
  const flushId = String(message.flushId || "");
  saveWhiteboardScene(index, message).then(
    () => {
      if (flushId) postToWhiteboard({ type: "luxe-whiteboard:saveResult", flushId, ok: true });
    },
    (error) => {
      if (flushId) {
        postToWhiteboard({
          type: "luxe-whiteboard:saveResult",
          flushId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

// "Save to machine": the explicit keep that takes a scene out of the ephemeral
// sidecar and writes it next to the artifact. The scene is persisted to the
// sidecar first, in the same chain as every other save, so the copy on disk and
// the copy next to the artifact are the same bytes.
async function saveWhiteboardToMachine(index, message) {
  try {
    await saveWhiteboardScene(index, message);
    const response = await fetch("/api/" + key + "/whiteboard/" + index + "/save-to-machine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: message.scene || null, pngDataUrl: String(message.pngDataUrl || "") }),
    });
    if (!response.ok) throw new Error("failed to write the whiteboard files");
    const files = await response.json();
    postToWhiteboard({
      type: "luxe-whiteboard:saveToMachineResult",
      ok: true,
      scenePath: String(files.scene_path || ""),
      previewPath: String(files.preview_path || ""),
    });
  } catch (error) {
    postToWhiteboard({
      type: "luxe-whiteboard:saveToMachineResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function whiteboardSummaryText(summaryLines) {
  return (Array.isArray(summaryLines) ? summaryLines : [])
    .filter((line) => typeof line === "string")
    .slice(0, 50)
    .map((line) => line.slice(0, 300))
    .join("\n");
}

async function queueWhiteboardFeedback(index, message) {
  const diagramId = whiteboardRecord(index).diagramId;
  try {
    // Persist the exact reviewed state before queueing, so the paths in the
    // prompt point at what the user actually saw.
    await saveWhiteboardScene(index, message);
    const response = await fetch("/api/" + key + "/whiteboard/" + index + "/feedback-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: message.scene || null, pngDataUrl: String(message.pngDataUrl || "") }),
    });
    if (!response.ok) throw new Error("failed to write whiteboard feedback files");
    const files = await response.json();
    const note = String(message.note || "").slice(0, 4000);
    const summary = whiteboardSummaryText(message.summaryLines);
    const promptText =
      (note ? note + "\n\n" : "") +
      "Whiteboard edits to diagram " +
      (index + 1) +
      (diagramId ? " (" + diagramId + ")" : "") +
      ":\n" +
      (summary || "(no summary)") +
      "\n\nEdited scene JSON: " +
      String(files.scene_path || "") +
      (files.preview_path ? "\nPNG preview: " + String(files.preview_path) : "");
    enqueuePrompt({
      uid: "",
      prompt: promptText,
      selector: "",
      tag: "whiteboard",
      text: "Whiteboard: diagram " + (index + 1),
      target: {
        type: "excalidraw-scene",
        diagramIndex: index,
        diagramId,
        sourceHash: String(message.sourceHash || ""),
        scenePath: String(files.scene_path || ""),
        previewPath: String(files.preview_path || ""),
        imageFallback: Boolean(message.imageFallback),
        stats: message.stats && typeof message.stats === "object" ? message.stats : {},
      },
      // Re-queueing the same diagram's whiteboard before sending replaces the
      // earlier unsent prompt instead of stacking duplicates.
      [internalQueueKeyField]: "whiteboard:" + index,
    });
    postToWhiteboard({ type: "luxe-whiteboard:queueResult", ok: true });
    closeWhiteboard();
  } catch (error) {
    postToWhiteboard({
      type: "luxe-whiteboard:queueResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// A live reload replaces the artifact, and with it every rendered diagram, but
// an open overlay outlives it. Tell that overlay when its diagram's source
// changed underneath it, so the frame can surface staleness rather than let a
// scene converted from an older diagram merge into the new one unannounced.
async function refreshWhiteboardSource() {
  if (overlayIndex === null) return;
  const index = overlayIndex;
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    const nextHash = source ? String(source.hash || "") : "";
    const record = whiteboardRecord(index);
    if (nextHash !== record.sourceHash) {
      record.source = source ? String(source.source || "") : "";
      record.sourceHash = nextHash;
      postToWhiteboard({
        type: "luxe-whiteboard:sourceChanged",
        source: record.source,
        sourceHash: record.sourceHash,
      });
    }
  } catch {
    // Best effort - the staleness banner also re-arms on the next open.
  }
}

// Deliberately type-strict, not just range-strict. `Number(null)` and
// `Number("")` are both 0, so a coercing check would turn a missing or empty
// field in a message from untrusted content into a valid request for diagram 0.
function validWhiteboardIndex(value) {
  if (typeof value !== "number") return null;
  return Number.isInteger(value) && value >= 0 && value <= 999 ? value : null;
}

function handleAuthenticatedWhiteboardMessage(index, message) {
  if (message.type === "luxe-whiteboard:save") handleWhiteboardSave(index, message);
  if (message.type === "luxe-whiteboard:queueFeedback") queueWhiteboardFeedback(index, message);
  if (message.type === "luxe-whiteboard:saveToMachine") saveWhiteboardToMachine(index, message);
  if (message.type === "luxe-whiteboard:close") closeWhiteboard();
  if (message.type === "luxe-whiteboard:teardownReady") settleWhiteboardTeardown(index, message, true);
  if (message.type === "luxe-whiteboard:teardownFailed") settleWhiteboardTeardown(index, message, false);
  if (message.type === "luxe-whiteboard:flushComplete") finishWhiteboardFlush(index, message);
}

function handleOverlayWhiteboardMessage(event, message) {
  if (event.source !== whiteboardFrame.contentWindow || overlayIndex === null) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || index !== overlayIndex) return;
  if (message.type === "luxe-whiteboard:ready") {
    if (overlayFrameReady || overlayChannelId) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    overlayChannelId = channelId;
    authenticateWhiteboardChannel(channelId).then(async (authenticated) => {
      const isCurrent = () =>
        overlayIndex === index && overlayChannelId === channelId && event.source === whiteboardFrame.contentWindow;
      if (!authenticated) {
        if (isCurrent()) overlayChannelId = "";
        return;
      }
      if (!isCurrent()) return;
      const initialized = await handleWhiteboardReady(index, isCurrent);
      if (initialized && isCurrent()) overlayFrameReady = true;
    });
    return;
  }
  if (!overlayFrameReady || message.channelId !== overlayChannelId) return;
  handleAuthenticatedWhiteboardMessage(index, message);
}

window.addEventListener("message", (event) => {
  if (event.source !== whiteboardFrame.contentWindow) return;
  handleOverlayWhiteboardMessage(event, event.data || {});
});

function loadFrame() {
  if (artifactSrc) frame.src = artifactSrc;
}

function reloadArtifact() {
  closeMenus();
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
}

async function reloadAfterServerRestart() {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart();
  return chromeRestartReloadPromise;
}

async function reloadChromeAfterServerRestart() {
  let sawOutage = false;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (sawOutage && res.ok) {
        await flushWhiteboardsBeforeChromeReload();
        location.reload();
        return;
      }
    } catch {
      sawOutage = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await flushWhiteboardsBeforeChromeReload();
  location.reload();
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  switch (msg.type) {
    case "luxe:queuePrompt":
      enqueuePrompt(msg.prompt);
      return;
    case "luxe:snapshot":
      // Snapshot-request ledger, half two: a snapshot with no outstanding chrome request behind
      // it was pushed by the artifact page on its own initiative, so drop it.
      if (snapshotRequests.length && typeof msg.snapshot === "string") {
        const request = snapshotRequests.shift();
        pendingSnapshot = msg.snapshot;
        pendingSubmitPrompts = request.prompts;
        endAfterSubmit = request.endAfter;
        submitQueued();
      }
      return;
    case "luxe:layoutWarnings":
      handleLayoutWarningsForGate(msg.layout_warnings);
      submitLayoutWarnings(msg.layout_warnings).catch(() => {});
      return;
    case "luxe:openWhiteboard": {
      // This request has UI authority only. The server corroborates the strict index against
      // its own artifact source, and the overlay authenticates separately before any write.
      const index = validWhiteboardIndex(msg.diagramIndex);
      if (index !== null) openWhiteboardOverlay(index);
      return;
    }
    case "luxe:toggleAnnotationMode":
      toggleAnnotationMode();
      return;
    case "luxe:scroll":
      if (
        typeof msg.x === "number" &&
        Number.isFinite(msg.x) &&
        msg.x >= 0 &&
        typeof msg.y === "number" &&
        Number.isFinite(msg.y) &&
        msg.y >= 0
      ) {
        lastScroll = { x: msg.x, y: msg.y };
      }
      return;
    default:
      return;
  }
});

loadFrame();

function toggleAnnotationMode() {
  if (ended) return;
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "luxe:setAnnotationMode", enabled: annotation });
}

annotationSwitch.onclick = toggleAnnotationMode;

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => toggleMenu(moreButton, moreMenu);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", hideSendHint);
copyPathButton.onclick = copyFilePath;
reloadArtifactButton.onclick = reloadArtifact;
exportArtifactButton.onclick = exportArtifact;
endButton.onclick = () => {
  closeMenus();
  endSession({ farewell: true });
};
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
});
whiteboardCloseButton.onclick = closeWhiteboard;
// A second, explicit try. The first fires automatically when the card appears; browsers
// refuse that one for a user-opened tab, but some accept a close driven directly by a
// click. When it is refused again nothing happens and the card stays put, which is why
// the copy says "you can close this tab" rather than promising anything.
if (farewellClose) farewellClose.onclick = attemptTabClose;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!whiteboardOverlay.hidden) {
      closeWhiteboard();
    } else {
      closeMenus();
    }
  }
});
// Capture phase so the mode hotkey fires no matter where focus is in the chrome - including
// mid-keystroke in chatInput or an annotation-card textarea - without disturbing normal typing.
document.addEventListener(
  "keydown",
  (event) => {
    if (!isModeToggleHotkeyEvent(event)) return;
    event.preventDefault();
    toggleAnnotationMode();
  },
  true,
);
frame.addEventListener("load", () => {
  postToFrame({ type: "luxe:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "luxe:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  // A reload rebuilds the artifact's Edit affordances; if the overlay is still
  // open over the old document, tell the new one which diagram it owns so the
  // affordance renders in its busy state rather than offering a second editor.
  if (overlayIndex !== null) postToFrame({ type: "luxe:whiteboardOpened", diagramIndex: overlayIndex });
});

initializeLayoutGate();

// Do not open a stream for a session that is already over. An `ended` listener alone would
// only catch a session ending *while* this page is open; a reloaded ended tab would still
// connect and then sit on a dead stream. The server refuses these too, so neither side is
// load-bearing on its own.
if (!initialEnded) {
  const events = new EventSource("/events/" + key);
  eventStream = events;
  events.addEventListener("reload", () => {
    resetFrame().then((reloaded) => {
      if (reloaded) refreshWhiteboardSource();
    });
  });
  events.addEventListener("chrome-reload", () => reloadAfterServerRestart());
  events.addEventListener("agent-reply", (event) => addChat("agent", JSON.parse(event.data).text));
  events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
  events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));
  events.addEventListener("ended", () => markSessionEnded());
}

render();
initialChat.forEach((item) => addChat(item.role, item.text, true, item.kind));
if (initialEnded) markSessionEnded();
else setAgentPresence("waiting");
