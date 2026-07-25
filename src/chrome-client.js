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
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
// Mode state lives here and nowhere else: the chrome owns annotate/explore and drives the
// artifact SDK over postMessage. The initial value comes from the session bootstrap the
// server emitted, which is the same value it rendered the switch's aria-pressed from, so the
// switch and the state can never disagree at load. Missing or malformed bootstrap falls back
// to explore mode, matching ANNOTATION_DEFAULT in server.js.
let annotation = sessionData.annotationDefault === true;
let ended = false;
let agentPresence = "waiting";
let pendingSnapshot = "";
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
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let lastScroll = { x: 0, y: 0 };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

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
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
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

// Queued prompts are dashed with a clock glyph; while a send is in flight the
// same pills go solid, which is the "sent" treatment in the component table.
const PILL_CLOCK_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>';
const PILL_SENT_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function render() {
  const sending = Boolean(submitQueuedPromise);
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill' +
        (sending ? " sent" : "") +
        '"><span class="pill-state">' +
        (sending ? PILL_SENT_ICON : PILL_CLOCK_ICON) +
        '</span><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button></div><div class="pill-tooltip">' +
        (prompt.selector
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>",
    )
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
  scrollPanelToBottom();
}

function updateSendState() {
  sendButton.disabled = ended || agentPresence === "working";
  sendAndEndButton.disabled = sendButton.disabled;
}

function showSendHint() {
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
  chatInput.focus();
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
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

function addChat(role, text, shouldScroll = true) {
  if (!text) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small><div>" + escapeHtml(text) + "</div>";
  chatLog.appendChild(el);
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of chat) lastChatBubble = addChat(item.role, item.text, false) || lastChatBubble;
  if (workingBubble) {
    chatLog.appendChild(workingBubble);
    scrollElementIntoView(workingBubble);
  } else if (lastChatBubble) {
    scrollElementIntoView(lastChatBubble);
  }
}

function setAgentPresence(state) {
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

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }

  persistQueuedPrompts();
  render();
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

// Snapshot-request ledger, half one. Artifact JS can postMessage to its parent whenever it
// likes, so a `luxe:snapshot` message arriving is not evidence that the chrome asked for one.
// Every chrome-initiated request is recorded here first; the handler below consumes exactly
// one entry per snapshot it accepts and drops anything it did not ask for. The property this
// buys is narrow and worth stating exactly: an unsolicited `luxe:snapshot` on its own cannot
// drive a feedback POST, and a second one cannot overwrite the snapshot of a send already in
// flight.
//
// It is NOT a barrier against artifact JS initiating a send, and must not be described as
// one. `luxe:sendQueuedPrompts` is a documented product API (`window.luxe.sendQueuedPrompts`,
// see the input playbook in src/playbooks.js) whose whole purpose is letting an artifact
// control send committed feedback immediately; it calls sendQueued(), which records its own
// request on this queue. So artifact JS can queue a prompt and send it with the page outline
// attached, with no human click. That is by design: artifact JavaScript is written by the
// same agent the feedback goes back to. See the trust model note in README.md.
function requestSnapshot() {
  snapshotRequests.push("submit");
  postToFrame({ type: "luxe:requestSnapshot" });
}

function sendQueued(endAfter) {
  if (ended || agentPresence === "working") return;
  closeMenus();

  const text = chatInput.value.trim();
  if (text) {
    queued.push({ uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" });
    persistQueuedPrompts();
    addChat("user", text);
    chatInput.value = "";
    render();
  }
  if (!queued.length) {
    showSendHint();
    return;
  }
  hideSendHint();

  if (endAfter) endAfterSubmit = true;
  requestSnapshot();
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
        endSession();
      }
    }
  }
}

async function submitQueuedOnce() {
  const prompts = queued.slice();
  const shouldEndSession = endAfterSubmit;
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot };
  if (shouldEndSession) body.endSession = true;
  const response = await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("failed to submit queued prompts");
  for (const prompt of prompts) {
    const index = queued.indexOf(prompt);
    if (index !== -1) queued.splice(index, 1);
  }
  persistQueuedPrompts();
  render();
  if (shouldEndSession) {
    endAfterSubmit = false;
    markSessionEnded();
    return;
  }
  if (agentPresence === "listening") setAgentPresence("working");
}

function normalizeLayoutWarningsPayload(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && String(item.severity || "").toLowerCase() === "error")
    : [];
}

function isErrorLayoutWarning(warning) {
  return String(warning?.severity || "").toLowerCase() === "error";
}

function setLayoutIssueBanner(
  visible,
  text = "This surface has a severe layout failure. Your agent has been notified.",
) {
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
      "The browser found inaccessible or unusable content. Your agent has been notified and this will reveal after the next clean reload.";
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
    bannerText: "This surface has a severe layout failure. You chose to show it before the layout check passed.",
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
  const response = await fetch("/api/" + key + "/layout-warnings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout_warnings: normalizeLayoutWarningsPayload(layoutWarnings) }),
  });
  if (!response.ok) throw new Error("failed to submit layout warnings");
}

async function endSession() {
  if (ended) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded() {
  if (ended) return;
  ended = true;
  closeMenus();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  revealLayoutGate();
  postToFrame({ type: "luxe:setAnnotationMode", enabled: false });
  // The ended state is a change of interaction model, not a curtain: the chrome
  // recedes to 45%, drops the annotation hue (body.session-ended maps --gold to
  // --strong) and stops accepting input, while the artifact stays readable.
  document.body?.classList?.add("session-ended");
  endedChip.hidden = false;
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
  inlineWhiteboardChannels.clear();
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  frame.src = artifactSrc || frame.src;
}

function resetFrame() {
  if (artifactResetPromise) return artifactResetPromise;
  const hasLiveInlineWhiteboard = [...inlineWhiteboardChannels].some(
    ([index, channel]) => channel.initialized && index !== overlayIndex,
  );
  if (!hasLiveInlineWhiteboard) {
    replaceArtifactFrame();
    return Promise.resolve(true);
  }
  artifactResetPromise = flushInlineWhiteboards()
    .then((flushed) => {
      if (!flushed) return false;
      replaceArtifactFrame();
      return true;
    })
    .finally(() => {
      artifactResetPromise = null;
    });
  return artifactResetPromise;
}

// ---------------------------------------------------------------------------
// Whiteboards. The artifact SDK embeds one sandboxed whiteboard frame in place
// of each rendered Mermaid diagram. The chrome owns every server round trip
// and serves all frames concurrently. The overlay hosts the same frame page
// fullscreen when an inline frame asks to maximize - the inline frame is
// suspended while the overlay owns that diagram so two editors never autosave
// one sidecar.
// ---------------------------------------------------------------------------

/** @type {Map<number, { diagramId: string, source: string, sourceHash: string }>} */
const whiteboards = new Map();
/** @type {number | null} */
let overlayIndex = null;
let overlayFrameReady = false;
let overlayChannelId = "";
let overlayOpeningIndex = null;
let nextWhiteboardFlushId = 0;
let artifactResetPromise = null;
let chromeRestartReloadPromise = null;
const whiteboardTeardowns = new Map();
const whiteboardFlushes = new Map();
const whiteboardSaveChains = new Map();
const inlineWhiteboardChannels = new Map();

function whiteboardTheme() {
  // Luxe is light-only: no theme detection, no OS theme following.
  return "light";
}

function postToWhiteboardOverlay(message) {
  if (whiteboardFrame.contentWindow && overlayChannelId) {
    whiteboardFrame.contentWindow.postMessage({ ...message, channelId: overlayChannelId }, "*");
  }
}

function postToInlineWhiteboard(index, message) {
  const channel = inlineWhiteboardChannels.get(index);
  if (channel?.window) channel.window.postMessage({ ...message, channelId: channel.channelId }, "*");
}

function postToWhiteboard(index, placement, message) {
  if (placement === "overlay") postToWhiteboardOverlay(message);
  else postToInlineWhiteboard(index, message);
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

async function handleWhiteboardReady(index, mode, isCurrent) {
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
    postToWhiteboard(index, mode, {
      type: "luxe-whiteboard:init",
      mode,
      diagramIndex: index,
      diagramId: record.diagramId,
      source: record.source,
      sourceHash: record.sourceHash,
      saved,
      theme: whiteboardTheme(),
    });
    return true;
  } catch (error) {
    if (mode === "overlay") {
      showWhiteboardError("Could not open the whiteboard: " + (error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

function showWhiteboardOverlay(index) {
  if (ended) return;
  overlayIndex = index;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  whiteboardError.hidden = true;
  whiteboardOverlay.hidden = false;
  postToFrame({ type: "luxe:suspendWhiteboard", diagramIndex: index });
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
  inlineWhiteboardChannels.delete(index);
  if (!ended) postToFrame({ type: "luxe:resumeWhiteboard", diagramIndex: index });
}

function whiteboardTeardownKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardTeardown(index, placement, onComplete) {
  const key = whiteboardTeardownKey(index, placement);
  const pending = whiteboardTeardowns.get(key);
  if (pending) {
    if (onComplete) pending.promise.then(onComplete);
    return pending.promise;
  }
  const flushId = `whiteboard-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  const teardown = { index, placement, flushId, promise, resolve, onComplete };
  whiteboardTeardowns.set(key, teardown);
  const message = { type: "luxe-whiteboard:prepareTeardown", flushId };
  postToWhiteboard(index, placement, message);
  return promise;
}

function finishWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(true);
  teardown.resolve(true);
}

function failWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(false);
  teardown.resolve(false);
}

function whiteboardFlushKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardFlush(index, placement) {
  const flushKey = whiteboardFlushKey(index, placement);
  const pending = whiteboardFlushes.get(flushKey);
  if (pending) return pending.promise;
  const flushId = `whiteboard-flush-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardFlushes.set(flushKey, { index, placement, flushId, promise, resolve });
  postToWhiteboard(index, placement, { type: "luxe-whiteboard:flush", flushId });
  return promise;
}

function finishWhiteboardFlush(index, message, placement) {
  const flushId = String(message.flushId || "");
  const flushKey = whiteboardFlushKey(index, placement);
  const flush = whiteboardFlushes.get(flushKey);
  if (!flush || flush.index !== index || flush.placement !== placement || flush.flushId !== flushId) return;
  whiteboardFlushes.delete(flushKey);
  flush.resolve(Boolean(message.ok));
}

async function flushWhiteboardsBeforeChromeReload() {
  const flushes = [];
  for (const [index, channel] of inlineWhiteboardChannels) {
    if (channel.initialized && index !== overlayIndex) flushes.push(beginWhiteboardFlush(index, "inline"));
  }
  if (overlayIndex !== null && overlayFrameReady) flushes.push(beginWhiteboardFlush(overlayIndex, "overlay"));
  if (flushes.length === 0) return;
  let timeout;
  await Promise.race([
    Promise.all(flushes),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 1500);
    }),
  ]);
  clearTimeout(timeout);
}

async function flushInlineWhiteboards() {
  for (const [index, channel] of [...inlineWhiteboardChannels]) {
    if (!channel.initialized || index === overlayIndex) continue;
    if (!(await beginWhiteboardTeardown(index, "inline"))) return false;
  }
  return true;
}

function openWhiteboardOverlay(index) {
  if (ended || overlayIndex !== null || overlayOpeningIndex !== null) return;
  overlayOpeningIndex = index;
  beginWhiteboardTeardown(index, "inline", (flushed) => {
    if (overlayOpeningIndex !== index) return;
    overlayOpeningIndex = null;
    if (flushed && !ended && overlayIndex === null) showWhiteboardOverlay(index);
  });
}

function closeWhiteboard() {
  const index = overlayIndex;
  if (index === null) return;
  if (!overlayFrameReady) {
    finishWhiteboardClose(index);
    return;
  }
  beginWhiteboardTeardown(index, "overlay", (flushed) => {
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

function handleWhiteboardSave(index, message, mode) {
  const flushId = String(message.flushId || "");
  saveWhiteboardScene(index, message).then(
    () => {
      if (flushId) postToWhiteboard(index, mode, { type: "luxe-whiteboard:saveResult", flushId, ok: true });
    },
    (error) => {
      if (flushId) {
        postToWhiteboard(index, mode, {
          type: "luxe-whiteboard:saveResult",
          flushId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

function whiteboardSummaryText(summaryLines) {
  return (Array.isArray(summaryLines) ? summaryLines : [])
    .filter((line) => typeof line === "string")
    .slice(0, 50)
    .map((line) => line.slice(0, 300))
    .join("\n");
}

async function queueWhiteboardFeedback(index, message, mode) {
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
    postToWhiteboard(index, mode, { type: "luxe-whiteboard:queueResult", ok: true });
    if (mode === "overlay") closeWhiteboard();
  } catch (error) {
    postToWhiteboard(index, mode, {
      type: "luxe-whiteboard:queueResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Inline frames live inside the artifact iframe, so a live reload replaces
// them wholesale and they re-init against fresh sources on their own. Only an
// open overlay outlives the reload; tell it when its diagram's source changed
// underneath it so the frame can surface staleness (never silently merge).
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
      postToWhiteboardOverlay({
        type: "luxe-whiteboard:sourceChanged",
        source: record.source,
        sourceHash: record.sourceHash,
      });
    }
  } catch {
    // Best effort - the staleness banner also re-arms on the next open.
  }
}

function validWhiteboardIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 999 ? index : null;
}

function handleAuthenticatedWhiteboardMessage(index, message, mode) {
  if (message.type === "luxe-whiteboard:save") handleWhiteboardSave(index, message, mode);
  if (message.type === "luxe-whiteboard:queueFeedback") queueWhiteboardFeedback(index, message, mode);
  if (message.type === "luxe-whiteboard:maximize" && mode === "inline") openWhiteboardOverlay(index);
  if (message.type === "luxe-whiteboard:close" && mode === "overlay") closeWhiteboard();
  if (message.type === "luxe-whiteboard:teardownReady") finishWhiteboardTeardown(index, message, mode);
  if (message.type === "luxe-whiteboard:teardownFailed") failWhiteboardTeardown(index, message, mode);
  if (message.type === "luxe-whiteboard:flushComplete") finishWhiteboardFlush(index, message, mode);
}

function handleInlineWhiteboardMessage(event, message) {
  if (ended) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || !event.source) return;
  if (message.type === "luxe-whiteboard:ready") {
    if (inlineWhiteboardChannels.has(index)) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    authenticateWhiteboardChannel(channelId).then((authenticated) => {
      if (!authenticated || ended || inlineWhiteboardChannels.has(index)) return;
      const channel = { window: event.source, channelId, initialized: false };
      inlineWhiteboardChannels.set(index, channel);
      whiteboardRecord(index).diagramId = String(message.diagramId || "");
      handleWhiteboardReady(index, "inline", () => inlineWhiteboardChannels.get(index) === channel).then(
        (initialized) => {
          if (inlineWhiteboardChannels.get(index) === channel) channel.initialized = initialized;
        },
      );
    });
    return;
  }
  const channel = inlineWhiteboardChannels.get(index);
  if (!channel || channel.window !== event.source || channel.channelId !== message.channelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "inline");
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
      const initialized = await handleWhiteboardReady(index, "overlay", isCurrent);
      if (initialized && isCurrent()) overlayFrameReady = true;
    });
    return;
  }
  if (!overlayFrameReady || message.channelId !== overlayChannelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "overlay");
}

window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (event.source === whiteboardFrame.contentWindow) {
    handleOverlayWhiteboardMessage(event, message);
  } else {
    handleInlineWhiteboardMessage(event, message);
  }
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
  if (msg.type === "luxe:queuePrompt") {
    enqueuePrompt(msg.prompt);
  }
  if (msg.type === "luxe:snapshot") {
    // Snapshot-request ledger, half two: a snapshot with no outstanding request behind it was
    // pushed by the artifact page on its own initiative, so drop it. Only a snapshot the
    // chrome asked for may drive a feedback POST. Note what that does and does not mean: it
    // means an unsolicited `luxe:snapshot` alone is inert, not that only a human can cause a
    // send. The chrome also asks for a snapshot when the artifact calls the documented
    // `luxe:sendQueuedPrompts` API below.
    if (snapshotRequests.length) {
      snapshotRequests.shift();
      pendingSnapshot = msg.snapshot || "";
      submitQueued();
    }
  }
  if (msg.type === "luxe:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "luxe:layoutWarnings") {
    handleLayoutWarningsForGate(msg.layout_warnings);
    submitLayoutWarnings(msg.layout_warnings).catch(() => {});
  }
  // Documented, intentional product API. `window.luxe.sendQueuedPrompts()` is what the input
  // playbook tells artifact authors to call when a control should send committed feedback
  // immediately instead of waiting for the human to press Send to Agent, so this path is a
  // feature, not a gap. Do not "harden" it away: the in-page question pattern depends on it.
  if (msg.type === "luxe:sendQueuedPrompts") sendQueued();
  if (msg.type === "luxe:endSession") endSession();
  if (msg.type === "luxe:toggleAnnotationMode") toggleAnnotationMode();
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
  endSession();
};
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
});
whiteboardCloseButton.onclick = closeWhiteboard;
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
  if (overlayIndex !== null) {
    inlineWhiteboardChannels.delete(overlayIndex);
    postToFrame({ type: "luxe:suspendWhiteboard", diagramIndex: overlayIndex });
  }
});

initializeLayoutGate();

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => {
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
});
events.addEventListener("chrome-reload", () => reloadAfterServerRestart());
events.addEventListener("agent-reply", (event) => addChat("agent", JSON.parse(event.data).text));
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));

render();
initialChat.forEach((item) => addChat(item.role, item.text));
setAgentPresence("waiting");
