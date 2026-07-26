import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeLayoutWarningReport } from "./layout-warnings.js";
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";
import { isValidDiagramIndex, whiteboardFeedbackPaths } from "./whiteboard-store.js";

const mutationTails = new Map();

export class SessionStore {
  constructor(file) {
    this.file = file;
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    const state = await this.readState();
    return state.sessions[sessionKey(absolute)] || null;
  }

  async findByKey(key) {
    const state = await this.readState();
    return state.sessions[key] || null;
  }

  async upsertSession(file, url) {
    const absolute = await canonicalFile(file);
    const key = sessionKey(absolute);
    return queueStateMutation(this.file, async () => {
      const state = await this.readState();
      const existing = state.sessions[key] || {};
      const existingPrompts = existing.prompts || [];
      const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
      const session = {
        key,
        file: absolute,
        url,
        status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
        pending_prompts: existing.pending_prompts || 0,
        prompts: existingPrompts,
        layout_warnings: [],
        delivered_layout_warning_keys: existing.delivered_layout_warning_keys || [],
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      await this.writeState(state);
      return session;
    });
  }

  async queuePrompts(key, payload) {
    return queueStateMutation(this.file, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      const shouldEndSession = Boolean(payload.endSession || payload.end_session);
      const alreadyEnded = session.status === "ended";
      const acceptedPromptIndices = [];
      const rejectedPrompts = [];
      const normalizedPrompts = [];
      for (const [index, prompt] of prompts.entries()) {
        const result = normalizePrompt(prompt, { stateDir: path.dirname(this.file), key });
        if (result.code) {
          rejectedPrompts.push({ index, code: result.code });
        } else {
          acceptedPromptIndices.push(index);
          normalizedPrompts.push(result.prompt);
        }
      }
      const sessionEnded = (shouldEndSession && rejectedPrompts.length === 0) || alreadyEnded;
      if (normalizedPrompts.length === 0) {
        return {
          session,
          acceptedPromptIndices,
          rejectedPrompts,
          sessionEnded: alreadyEnded,
          hasWhiteboardFeedback: (session.prompts || []).some(
            (prompt) => prompt.target?.type === EXCALIDRAW_SCENE_TARGET_TYPE,
          ),
        };
      }
      const userMessages = normalizedPrompts
        .filter((prompt) => prompt.tag === "message" && prompt.prompt)
        .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
      session.prompts = [...(session.prompts || []), ...normalizedPrompts];
      const hasWhiteboardFeedback = session.prompts.some(
        (prompt) => prompt.target?.type === EXCALIDRAW_SCENE_TARGET_TYPE,
      );
      session.chat = [...(session.chat || []), ...userMessages];
      session.pending_prompts = session.prompts.length;
      session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
      session.status = sessionEnded ? "ended" : "feedback";
      if (shouldEndSession && sessionEnded) session.ended_by = "user";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, acceptedPromptIndices, rejectedPrompts, sessionEnded, hasWhiteboardFeedback };
    });
  }

  async recordLayoutWarnings(key, payload) {
    return queueStateMutation(this.file, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const deliveredWarningKeys = session.delivered_layout_warning_keys || [];
      const deliveredKeys = new Set(deliveredWarningKeys);
      const layoutWarningsValue = Object.hasOwn(payload, "layout_warnings")
        ? payload.layout_warnings
        : Object.hasOwn(payload, "layoutWarnings")
          ? payload.layoutWarnings
          : undefined;
      const layoutWarnings = normalizeLayoutWarnings(layoutWarningsValue, deliveredKeys);
      const activeWarningKeys = new Set(layoutWarnings.map(layoutWarningKey));
      const nextDeliveredWarningKeys = deliveredWarningKeys.filter((key) => activeWarningKeys.has(key)).slice(-200);
      const deliveredKeysChanged =
        nextDeliveredWarningKeys.length !== deliveredWarningKeys.length ||
        nextDeliveredWarningKeys.some((key, index) => key !== deliveredWarningKeys[index]);
      const previousSignature = JSON.stringify(session.layout_warnings || []);
      const nextSignature = JSON.stringify(layoutWarnings);
      const warningsChanged = previousSignature !== nextSignature;
      if (!warningsChanged && !deliveredKeysChanged) {
        return { session, changed: false, hasWarnings: layoutWarnings.length > 0 };
      }
      session.layout_warnings = layoutWarnings;
      session.delivered_layout_warning_keys = nextDeliveredWarningKeys;
      if (layoutWarnings.length > 0 && session.status !== "ended") {
        session.status = "feedback";
      } else if ((session.prompts || []).length === 0 && session.status !== "ended") {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: warningsChanged, hasWarnings: layoutWarnings.length > 0 };
    });
  }

  async takeFeedback(key) {
    return queueStateMutation(this.file, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return { status: "missing" };
      }
      // Prompts queued before the session ended (a browser send-and-end) must still reach the
      // agent, so deliver them before reporting the ended state; the next poll then sees ended.
      const prompts = session.prompts || [];
      const layoutWarnings = normalizeStoredLayoutWarnings(
        session.layout_warnings,
        new Set(session.delivered_layout_warning_keys || []),
      );
      const alreadyEnded = session.status === "ended";
      if (prompts.length === 0 && layoutWarnings.length === 0) {
        return alreadyEnded ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
      }
      const result = {
        status: "feedback",
        dom_snapshot: session.dom_snapshot || "",
        prompts,
        ...(layoutWarnings.length > 0 ? { layout_warnings: layoutWarnings } : {}),
        // This is the final delivery before the session shows as ended - flag it so the agent
        // knows not to expect (or force) a reopened browser afterward.
        ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
      };
      session.prompts = [];
      session.layout_warnings = [];
      session.pending_prompts = 0;
      session.dom_snapshot = "";
      if (layoutWarnings.length > 0) {
        const deliveredKeys = new Set(session.delivered_layout_warning_keys || []);
        for (const warning of layoutWarnings) deliveredKeys.add(layoutWarningKey(warning));
        session.delivered_layout_warning_keys = [...deliveredKeys].slice(-200);
      }
      if (!alreadyEnded) {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return result;
    });
  }

  // `endedBy` distinguishes a human ending review from the browser chrome ("user") from an
  // agent explicitly closing the loop via `luxe end` ("agent"). Only a user-initiated end
  // blocks a plain reopen - see `SessionStore` callers in server.js.
  async endSession(key, endedBy = "agent") {
    return queueStateMutation(this.file, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const existingEndedBy = session.status === "ended" ? session.ended_by : undefined;
      const nextEndedBy = endedBy === "user" || existingEndedBy === "user" ? "user" : "agent";
      session.status = "ended";
      session.ended_by = nextEndedBy;
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async addAgentReply(key, text) {
    return queueStateMutation(this.file, async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      session.chat = [
        ...(session.chat || []),
        { role: "agent", text: String(text || ""), at: new Date().toISOString() },
      ];
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
  }

  // Owner-only on creation. state.json carries every session's prompts, chat history and the
  // DOM snapshot of the last send - a text outline of whatever the artifact rendered - for
  // every project on this machine, so it must not be world-readable. `mode` only applies when
  // the file is created; a state file that predates this (or was loosened by hand) is
  // tightened by ensureStateDir() at CLI start. See STATE_FILE_MODE in paths.js.
  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

function queueStateMutation(file, operation) {
  const key = path.resolve(file);
  const prior = mutationTails.get(key) || Promise.resolve();
  const result = prior.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  mutationTails.set(key, tail);
  tail.finally(() => {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  });
  return result;
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

function normalizePrompt(prompt, sessionRef) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const targetResult = normalizeTarget(prompt.target, sessionRef);
  if (targetResult.code) return targetResult;
  if (targetResult.target) normalized.target = targetResult.target;
  return { prompt: normalized };
}

function layoutWarningKey(warning) {
  const overflowPx = warning.overflowPx;
  const magnitude =
    overflowPx <= 0
      ? "none"
      : overflowPx < 24
        ? "small"
        : overflowPx < 64
          ? "medium"
          : overflowPx < 160
            ? "large"
            : "extreme";
  return `${warning.kind}:${warning.selector}:${warning.axis}:${magnitude}`;
}

// A finding whose key was already delivered to the agent in a prior poll is marked persistent
// so the agent can tell a fix attempt didn't clear it, instead of treating a reload's re-report
// of the identical warning as fresh.
function normalizeLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  return normalizeLayoutWarningReport(layoutWarnings).map((warning) => ({
    ...warning,
    persistent: deliveredKeys.has(layoutWarningKey(warning)),
  }));
}

function normalizeStoredLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  if (!Array.isArray(layoutWarnings) || layoutWarnings.length > 50) return [];
  const normalized = [];
  for (const warning of layoutWarnings) {
    try {
      normalized.push(...normalizeLayoutWarnings([warning], deliveredKeys));
    } catch {
      // State from an older build is untrusted input. Invalid legacy warnings are discarded
      // rather than allowed to bypass the current artifact-to-agent policy.
    }
  }
  return normalized;
}

function normalizeTarget(target, sessionRef) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return { target: null };
  if (target.type === "mermaid-node") return { target: normalizeMermaidNodeTarget(target) };
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) {
    if (!isValidDiagramIndex(target.diagramIndex)) return { code: "invalid_whiteboard_target" };
    const diagramIndex = Number(target.diagramIndex);
    const expected = whiteboardFeedbackPaths(sessionRef.stateDir, sessionRef.key, diagramIndex);
    if (typeof target.scenePath !== "string" || target.scenePath !== expected.scenePath) {
      return { code: "invalid_whiteboard_target" };
    }
    const previewPath = target.previewPath === undefined ? "" : target.previewPath;
    if (typeof previewPath !== "string" || (previewPath !== "" && previewPath !== expected.previewPath)) {
      return { code: "invalid_whiteboard_target" };
    }
    return {
      target: normalizeExcalidrawSceneTarget({
        ...target,
        diagramIndex,
        scenePath: expected.scenePath,
        previewPath,
      }),
    };
  }
  if (["scenePath", "previewPath", "scene_path", "preview_path"].some((field) => Object.hasOwn(target, field))) {
    return { code: "invalid_whiteboard_target" };
  }
  if (target.type === "text-range") {
    const normalizeAnchor = (anchor) => ({
      selector: String(anchor?.selector || ""),
      path: Array.isArray(anchor?.path) ? anchor.path.map((segment) => Number(segment)) : [],
      offset: Number(anchor?.offset) || 0,
    });
    return {
      target: {
        type: "text-range",
        text: String(target.text || ""),
        selector: String(target.selector || ""),
        start: normalizeAnchor(target.start),
        end: normalizeAnchor(target.end),
      },
    };
  }
  // Unknown target shapes carry no authority and are dropped. The closed target union is
  // enforced more deeply by the semantic-limit boundary, but arbitrary path-like legacy
  // objects must not survive this whiteboard boundary in the meantime.
  return { target: null };
}
