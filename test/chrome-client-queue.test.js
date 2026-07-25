import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../src/chrome-client.js", import.meta.url);

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string, annotationDefault?: boolean }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i" };

async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const storage = new Map();
  const postedToFrame = [];
  const postedToWhiteboard = [];
  const inlineWhiteboards = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;
  let reloadCount = 0;

  function fakeSetTimeout(fn, ms) {
    const timer = {
      id: nextTimerId++,
      ms,
      fn,
      unref() {},
    };
    timers.set(timer.id, timer);
    return timer;
  }

  function fakeClearTimeout(timer) {
    if (timer && typeof timer === "object") timers.delete(timer.id);
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      scrolledIntoView: null,
      dataset: {},
      onclick: null,
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) {
          return classes.has(name);
        },
        toString() {
          return [...classes].join(" ");
        },
      },
      style: {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      querySelectorAll() {
        return [];
      },
      querySelector(selector) {
        if (selector !== "span") return null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      appendChild(child) {
        child.parentElement = this;
        this.lastAppendedChild = child;
        return child;
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {},
      focus() {
        this.focused = true;
      },
      select() {},
      scrollIntoView(options) {
        this.scrolledIntoView = options;
      },
      listeners,
    };
    elements.set(id, el);
    return el;
  }

  element("luxe-session").textContent = JSON.stringify(sessionData);
  const frame = element("artifact");
  frame.dataset.artifactSrc = artifactSrc;
  Object.defineProperty(frame, "src", {
    get() {
      return this.currentSrc || "";
    },
    set(value) {
      this.currentSrc = String(value);
      srcLoads.push({ src: this.currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  frame.contentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  const whiteboardFrame = element("whiteboardFrame");
  whiteboardFrame.contentWindow = {
    postMessage(message) {
      postedToWhiteboard.push(message);
    },
  };

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
    fetch: fetchImpl,
    location: {
      reload() {
        reloadCount += 1;
      },
    },
    navigator: {},
    setTimeout: fakeSetTimeout,
    URL: {
      createObjectURL() {
        return "blob:luxe-test";
      },
      revokeObjectURL() {},
    },
    EventSource: class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        eventSources.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }
    },
    document: {
      body: element("body"),
      getElementById(id) {
        return element(id);
      },
      addEventListener(type, handler, capture) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ handler, capture: Boolean(capture) });
      },
      createElement(tag) {
        const el = element(`${tag}-${elements.size}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
      execCommand() {
        return true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    window: {
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });

  return {
    element,
    frame,
    postedToFrame,
    postedToWhiteboard,
    createInlineWhiteboard() {
      const posted = [];
      const source = {
        postMessage(message) {
          posted.push(message);
        },
      };
      const whiteboard = { source, posted };
      inlineWhiteboards.push(whiteboard);
      return whiteboard;
    },
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: frame.contentWindow, data });
    },
    sendWhiteboardMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboardFrame.contentWindow, data });
    },
    sendInlineWhiteboardMessage(whiteboard, data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboard.source, data });
    },
    dispatchDocumentKeydown(eventProps) {
      const handlers = documentListeners.get("keydown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document keydown handler");
      const event = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    dispatchDocumentEvent(type, eventProps = {}) {
      const handlers = documentListeners.get(type) || [];
      assert.ok(handlers.length > 0, `chrome-client registered a document ${type} handler`);
      const event = {
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("luxe:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    runTimers,
    srcLoads,
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("chrome client replaces queued prompts with the same internal key", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Use plan A", selector: "input#plan-a", tag: "choice", text: "Plan A", _luxeQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _luxeQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Apply dark mode", selector: "button#dark", tag: "choice", text: "Dark" },
  });

  assert.deepEqual(
    chrome.queued().map((prompt) => prompt.prompt),
    ["Use plan B", "Apply dark mode"],
  );
  assert.match(chrome.element("annotationPills").innerHTML, /Use plan B/);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /Use plan A/);
});

test("chrome client scrolls new chat bubbles into view above queued prompts", async () => {
  const chrome = await createChromeHarness();
  const panelScroll = chrome.element("panelScroll");
  panelScroll.scrollHeight = 1800;

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Review the title", selector: "h1", tag: "annotation", text: "Title" },
  });
  assert.equal(panelScroll.scrollTop, 1800);

  panelScroll.scrollTop = 640;
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ text: "I updated the title." }),
  });

  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.equal(bubble.scrolledIntoView.block, "nearest");
  assert.equal(bubble.scrolledIntoView.inline, "nearest");
  assert.equal(panelScroll.scrollTop, 640);
});

test("chrome client posts layout warnings from the artifact iframe", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/layout-warnings");
  assert.deepEqual(posts[0].body, {
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
});

test("chrome client surfaces export warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-luxe-export-warning-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 unresolved asset");
});

test("chrome client surfaces export notices from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-luxe-export-warning-count") return "0";
          if (name.toLowerCase() === "x-luxe-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 notice");
});

test("chrome client includes export notices alongside unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-luxe-export-warning-count") return "2";
          if (name.toLowerCase() === "x-luxe-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(
    chrome.element("exportArtifact").querySelector("span").textContent,
    "Exported with 2 unresolved assets and 1 notice",
  );
});

test("chrome client registers message listener before loading the artifact iframe", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.deepEqual(chrome.srcLoads, [{ src: "/artifact/abc/index.html", hadMessageListener: true }]);
});

test("layout gate reveals after a clean audit result", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({ type: "luxe:layoutWarnings", layout_warnings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
  assert.deepEqual(posts[0], { url: "/api/abc/layout-warnings", body: { layout_warnings: [] } });
});

test("layout gate holds on error severity audit findings and still posts them", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
  assert.deepEqual(posts[0].body.layout_warnings[0].severity, "error");
});

test("warning-only layout observations are discarded before gate and feedback submission", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [
      {
        selector: ".card",
        kind: "text-clipped",
        overflowPx: 2,
        viewportWidth: 720,
        severity: "warning",
      },
      {
        selector: ".unproven",
        kind: "text-clipped",
        overflowPx: 200,
        viewportWidth: 720,
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
  assert.deepEqual(posts[0].body, { layout_warnings: [] });
});

test("layout gate timeout fails open without an issue banner when no severe result arrives", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("a proven severe result is not mistaken for an uncertain audit timeout", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("a late clean audit stays clean after the layout gate times out", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);
  chrome.sendFrameMessage({ type: "luxe:layoutWarnings", layout_warnings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("layout gate timeout re-arms on reload", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);

  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
});

test("layout gate manual override reveals immediately", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
  // The label goes into its own span. Writing it onto the banner would delete
  // the alert icon the server renders beside it, and status never travels as
  // colour alone (UI-REVAMP 2.6).
  assert.match(chrome.element("layoutIssueBannerText").textContent, /severe layout failure/);
  assert.equal(chrome.element("layoutIssueBanner").textContent, "");
});

test("layout gate manual override stays bypassed on reload", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();
  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate stays skipped when the session disables it", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateEnabled: false },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "luxe:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

// The snapshot-request ledger. Artifact JS can postMessage to its parent whenever it likes,
// so a `luxe:snapshot` the chrome never asked for must not be treated as the answer to a
// request. The property under test is narrow and exactly that: an unsolicited snapshot on its
// own is inert. It is NOT "only a human can cause a send" - see the sendQueuedPrompts test
// below, which pins the documented artifact-initiated path.
test("a snapshot the chrome never requested does not trigger a send", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" },
  });

  // No Send happened, so nothing asked the artifact for a snapshot.
  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "exfiltrated page text" });
  await flushPromises();
  await flushPromises();

  assert.equal(posts.length, 0);
  assert.equal(chrome.queued().length, 1, "the queue is untouched, so the next real Send still works");

  // And the gate consumes exactly one request per Send: a second unrequested snapshot after a
  // legitimate one is dropped too, rather than replaying the send.
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.domSnapshot, "uid=1 body");

  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "exfiltrated page text" });
  await flushPromises();
  await flushPromises();
  assert.equal(posts.length, 1);
});

// INTENTIONAL PRODUCT BEHAVIOR - do not "harden" this away.
// `window.luxe.sendQueuedPrompts()` posts `luxe:sendQueuedPrompts` and the chrome sends, with
// no human click. The input playbook (src/playbooks.js) tells artifact authors to call it when
// a control should send committed feedback immediately, and the in-page question pattern the
// owner uses depends on it. Artifact JS is written by the same agent the feedback goes back
// to, so this is a designed capability, not a bypass of the snapshot ledger. If a future
// change to that ledger makes this test fail, the change is the bug.
test("artifact-initiated sendQueuedPrompts DOES send - documented API, not a hole to plug", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" },
  });

  // The artifact asks for the send itself, exactly as window.luxe.sendQueuedPrompts() does.
  chrome.sendFrameMessage({ type: "luxe:sendQueuedPrompts" });
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:requestSnapshot");

  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.equal(posts.length, 1, "the documented artifact-initiated send must still reach the agent");
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.deepEqual(posts[0].body.prompts, [
    { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" },
  ]);
  assert.equal(posts[0].body.domSnapshot, "uid=1 body");
  assert.equal(chrome.queued().length, 0);
});

test("chrome client strips the internal queue key before posting prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _luxeQueueKey: "plan" },
  });
  chrome.element("send").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:requestSnapshot");

  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(chrome.queued().length, 0);
});

test("chrome send and end carries the end intent with queued prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("sendAndEnd").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:requestSnapshot");

  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
    endSession: true,
  });
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("chrome send and end with an empty composer nudges instead of ending", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("sendAndEnd").onclick();
  await flushPromises();

  assert.equal(posts.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.equal(chrome.element("chatInput").focused, true);
  assert.equal(chrome.element("chatInput").disabled, false);
});

test("chrome send and end during an in-flight submit still ends after the submit drains the queue", async () => {
  const posts = [];
  let resolveFirstPost = () => {};
  const firstPost = new Promise((resolve) => {
    resolveFirstPost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (posts.length === 1) await firstPost;
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.element("sendAndEnd").onclick();
  chrome.sendFrameMessage({ type: "luxe:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  resolveFirstPost();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts", "/api/abc/end"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(posts[1].body, null);
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("Cmd/Ctrl+I toggles annotation mode from the chrome document, regardless of focus", async () => {
  const chrome = await createChromeHarness();

  // Annotation starts off, so the first press turns it on.
  const metaEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(metaEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);

  const ctrlEvent = chrome.dispatchDocumentKeydown({ key: "I", ctrlKey: true });
  assert.equal(ctrlEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

// The default lives in the session bootstrap the server emits, and the chrome reads it from
// there instead of carrying a literal. Off by default, on after exactly one toggle.
test("annotation mode defaults off and one toggle turns it on", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i", annotationDefault: false },
  });

  assert.equal(
    chrome.postedToFrame.some((message) => message.type === "luxe:setAnnotationMode"),
    false,
  );

  chrome.element("annotation").click();
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

// A bootstrap that says annotate-on must be honoured too: the chrome must be reading the
// field, not hardcoding the answer that happens to be today's default.
test("annotation mode follows the bootstrap when it says on", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i", annotationDefault: true },
  });

  chrome.element("annotation").click();
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("plain 'i' and other modifier combos do not toggle annotation mode", async () => {
  const chrome = await createChromeHarness();
  const framePostCount = () => chrome.postedToFrame.length;
  const before = framePostCount();

  const bareEvent = chrome.dispatchDocumentKeydown({ key: "i" });
  assert.equal(bareEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const shiftEvent = chrome.dispatchDocumentKeydown({ key: "i", shiftKey: true });
  assert.equal(shiftEvent.defaultPrevented, false);

  const ctrlShiftEvent = chrome.dispatchDocumentKeydown({ key: "i", ctrlKey: true, shiftKey: true });
  assert.equal(ctrlShiftEvent.defaultPrevented, false);

  const metaAltEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true, altKey: true });
  assert.equal(metaAltEvent.defaultPrevented, false);

  const otherKeyEvent = chrome.dispatchDocumentKeydown({ key: "s", metaKey: true });
  assert.equal(otherKeyEvent.defaultPrevented, false);

  assert.equal(framePostCount(), before);
});

test("chrome client reads the mode toggle hotkey from the session bootstrap", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "k" },
  });

  const oldHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(oldHotkeyEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const bootstrapHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "K", metaKey: true });
  assert.equal(bootstrapHotkeyEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("chrome client toggles annotation mode when the artifact SDK requests it via postMessage", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({ type: "luxe:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);

  chrome.sendFrameMessage({ type: "luxe:toggleAnnotationMode" });
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("chrome client ignores annotation mode toggles after the session ends", async () => {
  const chrome = await createChromeHarness();

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");

  chrome.sendFrameMessage({ type: "luxe:endSession" });
  await flushPromises();
  const afterEndPostCount = chrome.postedToFrame.length;

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  chrome.sendFrameMessage({ type: "luxe:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.length, afterEndPostCount);
});

function whiteboardFetch(url) {
  if (url.includes("/whiteboard-channel")) return { ok: true };
  if (url.includes("/mermaid-sources")) {
    return { ok: true, json: async () => ({ sources: [{ index: 0, source: "flowchart TD; A-->B", hash: "hash" }] }) };
  }
  return { ok: true, json: async () => ({ whiteboard: null }) };
}

async function initializeInlineWhiteboard(chrome, token = "inline-channel") {
  const whiteboard = chrome.createInlineWhiteboard();
  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "luxe-whiteboard:ready",
    diagramIndex: 0,
    diagramId: "mermaid-1",
    channelToken: token,
  });
  await flushPromises();
  await flushPromises();
  return whiteboard;
}

test("artifact relays cannot invoke whiteboard persistence", async () => {
  const calls = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return whiteboardFetch(url);
    },
  });

  chrome.sendFrameMessage({
    type: "luxe:whiteboardRelay",
    diagramIndex: 0,
    message: { type: "luxe-whiteboard:save", scene: { elements: [{ id: "forged" }] } },
  });
  await flushPromises();

  assert.equal(calls.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
});

test("unverified whiteboard frames cannot invoke whiteboard persistence", async () => {
  const calls = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return { ok: false };
    },
  });
  const whiteboard = chrome.createInlineWhiteboard();

  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "luxe-whiteboard:ready",
    diagramIndex: 0,
    channelToken: "forged",
  });
  await flushPromises();
  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "luxe-whiteboard:save",
    diagramIndex: 0,
    channelId: "forged",
    scene: { elements: [{ id: "forged" }] },
  });
  await flushPromises();

  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/abc/whiteboard-channel"],
  );
  assert.equal(whiteboard.posted.length, 0);
});

test("whiteboard fullscreen waits for the authenticated inline frame to flush", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);
  const init = inline.posted.at(-1);
  assert.equal(init.type, "luxe-whiteboard:init");
  assert.equal(init.channelId, "inline-channel");

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });

  const prepare = inline.posted.at(-1);
  assert.equal(prepare.type, "luxe-whiteboard:prepareTeardown");
  assert.equal(
    chrome.postedToFrame.some((message) => message.type === "luxe:suspendWhiteboard"),
    false,
  );

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: prepare.flushId,
  });

  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:suspendWhiteboard");
  assert.match(chrome.element("whiteboardFrame").src, /^\/whiteboard-frame\?diagramIndex=0$/);
});

test("whiteboard close waits for the authenticated overlay frame to flush", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "luxe-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  chrome.element("whiteboardClose").click();
  const closePrepare = chrome.postedToWhiteboard.at(-1);
  assert.equal(closePrepare.type, "luxe-whiteboard:prepareTeardown");
  assert.equal(closePrepare.channelId, "overlay-channel");
  assert.notEqual(chrome.element("whiteboardFrame").src, "about:blank");

  chrome.sendWhiteboardMessage({
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: closePrepare.flushId,
  });

  assert.equal(chrome.element("whiteboardFrame").src, "about:blank");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:resumeWhiteboard");
});

test("whiteboard fullscreen close accepts the resumed inline frame", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "luxe-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  chrome.element("whiteboardClose").click();
  const closePrepare = chrome.postedToWhiteboard.at(-1);
  chrome.sendWhiteboardMessage({
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: closePrepare.flushId,
  });

  const resumed = chrome.createInlineWhiteboard();
  chrome.sendInlineWhiteboardMessage(resumed, {
    type: "luxe-whiteboard:ready",
    diagramIndex: 0,
    diagramId: "mermaid-1",
    channelToken: "resumed-channel",
  });
  await flushPromises();
  await flushPromises();

  assert.equal(resumed.posted.at(-1).type, "luxe-whiteboard:init");
  assert.equal(resumed.posted.at(-1).channelId, "resumed-channel");
});

test("artifact reload waits for inline whiteboards to flush", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url) => whiteboardFetch(url),
  });
  const inline = await initializeInlineWhiteboard(chrome);
  const initialLoadCount = chrome.srcLoads.length;

  chrome.element("reloadArtifact").click();
  const prepare = inline.posted.at(-1);
  assert.equal(prepare.type, "luxe-whiteboard:prepareTeardown");
  assert.equal(chrome.srcLoads.length, initialLoadCount);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: prepare.flushId,
  });
  await flushPromises();

  assert.equal(chrome.srcLoads.length, initialLoadCount + 1);
  assert.equal(chrome.element("artifact").src, "/artifact/abc/index.html");
});

test("server restart flushes an authenticated inline whiteboard before reloading", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  const flush = inline.posted.at(-1);
  assert.equal(flush.type, "luxe-whiteboard:flush");
  assert.equal(chrome.reloadCount(), 0);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:flushComplete",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: flush.flushId,
    ok: true,
  });
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("server restart flushes an authenticated overlay before reloading", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const teardown = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: teardown.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "luxe-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  const flush = chrome.postedToWhiteboard.at(-1);
  assert.equal(flush.type, "luxe-whiteboard:flush");
  assert.equal(chrome.reloadCount(), 0);

  chrome.sendWhiteboardMessage({
    type: "luxe-whiteboard:flushComplete",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: flush.flushId,
    ok: true,
  });
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("server restart bounds the wait for a whiteboard flush", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  assert.equal(inline.posted.at(-1).type, "luxe-whiteboard:flush");
  chrome.runTimers(1500);
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("whiteboard close stays responsive while overlay initialization is pending", async () => {
  let delayOverlaySources = false;
  /** @type {(() => void) | undefined} */
  let releaseOverlaySources;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (delayOverlaySources && url.includes("/mermaid-sources")) {
        await new Promise((resolve) => {
          releaseOverlaySources = () => resolve();
        });
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "luxe-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });

  delayOverlaySources = true;
  chrome.sendWhiteboardMessage({ type: "luxe-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  chrome.element("whiteboardClose").click();

  assert.equal(chrome.element("whiteboardFrame").src, "about:blank");
  assert.equal(chrome.postedToFrame.at(-1).type, "luxe:resumeWhiteboard");
  assert.equal(
    chrome.postedToWhiteboard.some((message) => message.type === "luxe-whiteboard:prepareTeardown"),
    false,
  );

  releaseOverlaySources?.();
  await flushPromises();
});

test("clicking anywhere in the chrome asks the artifact frame to dismiss an open annotation card", async () => {
  const chrome = await createChromeHarness();
  const before = chrome.postedToFrame.length;

  chrome.dispatchDocumentEvent("pointerdown", {});

  const dismissals = chrome.postedToFrame
    .slice(before)
    .filter((message) => message.type === "luxe:dismissAnnotationCard");
  assert.equal(dismissals.length, 1);
});

test("the dismiss request is advisory: the chrome never assumes the card closed", async () => {
  const chrome = await createChromeHarness();

  // The frame owns the decision, because only it knows whether the card holds an
  // unsent draft. The chrome must not mirror card state or act on the outcome.
  const event = chrome.dispatchDocumentEvent("pointerdown", {});
  assert.equal(event.defaultPrevented, false);
});
