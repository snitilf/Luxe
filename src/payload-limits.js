export const DOM_SNAPSHOT_MAX_BYTES = 128 * 1024;
export const PROMPT_MAX_BYTES = 16 * 1024;
export const CONTEXT_MAX_BYTES = 4 * 1024;
export const SELECTOR_MAX_CHARS = 512;
export const PROMPT_BATCH_MAX = 100;
export const TARGET_IDENTIFIER_MAX_CHARS = 512;
// A topic is a label, not content: it is one line in a pill and one line in the
// conversation. The chrome trims to 60 for display; this is the transport bound.
export const TOPIC_MAX_CHARS = 80;
export const TEXT_RANGE_PATH_MAX_SEGMENTS = 64;
export const WHITEBOARD_SERIALIZED_MAX_BYTES = 8 * 1024 * 1024;
export const WHITEBOARD_PNG_MAX_BYTES = 8 * 1024 * 1024;
export const WHITEBOARD_ELEMENT_MAX = 10_000;
export const WHITEBOARD_FILE_MAX = 1_000;
export const SOURCE_HASH_MAX_CHARS = 256;

const EXCALIDRAW_STATS = ["added", "removed", "moved", "relabeled", "drawn"];

export class PayloadBoundaryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PayloadBoundaryError";
    this.status = status;
    this.code = code;
  }
}

function boundaryError(status, code, message) {
  return new PayloadBoundaryError(status, code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function requireString(value, label, maxBytes, { allowMissing = false, sizeCode = "payload_too_large" } = {}) {
  if (value === undefined && allowMissing) return "";
  if (typeof value !== "string") throw boundaryError(400, "invalid_payload", `${label} must be a string`);
  if (utf8Bytes(value) > maxBytes) {
    throw boundaryError(413, sizeCode, `${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function requireCharacterBoundedString(
  value,
  label,
  maxChars,
  { allowMissing = false, sizeCode = "payload_too_large" } = {},
) {
  if (value === undefined && allowMissing) return "";
  if (typeof value !== "string") throw boundaryError(400, "invalid_payload", `${label} must be a string`);
  if (value.length > maxChars) {
    throw boundaryError(413, sizeCode, `${label} exceeds ${maxChars} characters`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw boundaryError(400, "invalid_prompt", `${label} contains unknown field ${key}`);
  }
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw boundaryError(400, "invalid_prompt", `${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeTextRangeAnchor(anchor, label) {
  if (!isPlainObject(anchor)) throw boundaryError(400, "invalid_prompt", `${label} must be an object`);
  assertAllowedKeys(anchor, new Set(["selector", "path", "offset"]), label);
  const selector = requireCharacterBoundedString(anchor.selector, `${label}.selector`, SELECTOR_MAX_CHARS);
  if (!Array.isArray(anchor.path)) throw boundaryError(400, "invalid_prompt", `${label}.path must be an array`);
  if (anchor.path.length > TEXT_RANGE_PATH_MAX_SEGMENTS) {
    throw boundaryError(413, "prompt_too_large", `${label}.path exceeds ${TEXT_RANGE_PATH_MAX_SEGMENTS} segments`);
  }
  const path = Array.from(anchor.path, (segment, index) =>
    requireNonNegativeSafeInteger(segment, `${label}.path[${index}]`),
  );
  const offset = requireNonNegativeSafeInteger(anchor.offset, `${label}.offset`);
  return { selector, path, offset };
}

function normalizeStats(stats) {
  if (!isPlainObject(stats)) throw boundaryError(400, "invalid_prompt", "target.stats must be an object");
  assertAllowedKeys(stats, new Set(EXCALIDRAW_STATS), "target.stats");
  return Object.fromEntries(
    EXCALIDRAW_STATS.map((key) => [key, requireNonNegativeSafeInteger(stats[key], `target.stats.${key}`)]),
  );
}

function normalizeTarget(target) {
  if (!isPlainObject(target)) throw boundaryError(400, "invalid_prompt", "target must be an object");
  if (target.type === "text-range") {
    assertAllowedKeys(target, new Set(["type", "text", "selector", "start", "end"]), "text-range target");
    return {
      type: "text-range",
      text: requireString(target.text, "target.text", CONTEXT_MAX_BYTES, { sizeCode: "prompt_too_large" }),
      selector: requireCharacterBoundedString(target.selector, "target.selector", SELECTOR_MAX_CHARS, {
        sizeCode: "prompt_too_large",
      }),
      start: normalizeTextRangeAnchor(target.start, "target.start"),
      end: normalizeTextRangeAnchor(target.end, "target.end"),
    };
  }
  if (target.type === "mermaid-node") {
    assertAllowedKeys(target, new Set(["type", "diagramId", "nodeId", "label", "selector"]), "mermaid-node target");
    return {
      type: "mermaid-node",
      diagramId: requireCharacterBoundedString(target.diagramId, "target.diagramId", TARGET_IDENTIFIER_MAX_CHARS, {
        sizeCode: "prompt_too_large",
      }),
      nodeId: requireCharacterBoundedString(target.nodeId, "target.nodeId", TARGET_IDENTIFIER_MAX_CHARS, {
        sizeCode: "prompt_too_large",
      }),
      label: requireString(target.label, "target.label", CONTEXT_MAX_BYTES, { sizeCode: "prompt_too_large" }),
      selector: requireCharacterBoundedString(target.selector, "target.selector", SELECTOR_MAX_CHARS, {
        sizeCode: "prompt_too_large",
      }),
    };
  }
  if (target.type === "excalidraw-scene") {
    assertAllowedKeys(
      target,
      new Set([
        "type",
        "diagramIndex",
        "diagramId",
        "sourceHash",
        "scenePath",
        "previewPath",
        "imageFallback",
        "stats",
      ]),
      "excalidraw-scene target",
    );
    if (!Number.isInteger(target.diagramIndex) || target.diagramIndex < 0 || target.diagramIndex > 999) {
      throw boundaryError(400, "invalid_prompt", "target.diagramIndex is invalid");
    }
    if (typeof target.imageFallback !== "boolean") {
      throw boundaryError(400, "invalid_prompt", "target.imageFallback must be boolean");
    }
    return {
      type: "excalidraw-scene",
      diagramIndex: target.diagramIndex,
      diagramId: requireCharacterBoundedString(target.diagramId, "target.diagramId", TARGET_IDENTIFIER_MAX_CHARS, {
        allowMissing: true,
        sizeCode: "prompt_too_large",
      }),
      sourceHash: requireCharacterBoundedString(target.sourceHash, "target.sourceHash", SOURCE_HASH_MAX_CHARS, {
        allowMissing: true,
        sizeCode: "prompt_too_large",
      }),
      scenePath: requireString(target.scenePath, "target.scenePath", CONTEXT_MAX_BYTES, {
        sizeCode: "prompt_too_large",
      }),
      previewPath: requireString(target.previewPath, "target.previewPath", CONTEXT_MAX_BYTES, {
        allowMissing: true,
        sizeCode: "prompt_too_large",
      }),
      imageFallback: target.imageFallback,
      stats: normalizeStats(target.stats),
    };
  }
  throw boundaryError(400, "invalid_prompt", "target.type is invalid");
}

export function normalizePromptPayload(prompt) {
  if (!isPlainObject(prompt)) throw boundaryError(400, "invalid_prompt", "prompt must be an object");
  const normalized = {
    prompt: requireString(prompt.prompt, "prompt", PROMPT_MAX_BYTES, {
      allowMissing: true,
      sizeCode: "prompt_too_large",
    }),
    text: requireString(prompt.text, "prompt.text", CONTEXT_MAX_BYTES, {
      allowMissing: true,
      sizeCode: "prompt_too_large",
    }),
    selector: requireCharacterBoundedString(prompt.selector, "prompt.selector", SELECTOR_MAX_CHARS, {
      allowMissing: true,
      sizeCode: "prompt_too_large",
    }),
    tag: requireCharacterBoundedString(prompt.tag, "prompt.tag", TARGET_IDENTIFIER_MAX_CHARS, {
      allowMissing: true,
      sizeCode: "prompt_too_large",
    }),
  };
  // A short human name for the question this answers. It reaches the conversation receipt
  // and therefore the agent's chat history, so it is bounded like every other
  // artifact-supplied string rather than trusted. Omitted when absent, like target, so a
  // prompt without one keeps the shape the agent has always received.
  const topic = requireCharacterBoundedString(prompt.topic, "prompt.topic", TOPIC_MAX_CHARS, {
    allowMissing: true,
    sizeCode: "prompt_too_large",
  });
  if (topic) normalized.topic = topic;
  if (prompt.target !== undefined) normalized.target = normalizeTarget(prompt.target);
  return normalized;
}

export function validatePromptBatchPayload(payload) {
  if (!isPlainObject(payload)) throw boundaryError(400, "invalid_payload", "request body must be an object");
  if (!Array.isArray(payload.prompts)) throw boundaryError(400, "invalid_payload", "prompts must be an array");
  if (payload.prompts.length > PROMPT_BATCH_MAX) {
    throw boundaryError(413, "payload_too_large", `prompts exceeds ${PROMPT_BATCH_MAX} items`);
  }
  const domSnapshotValue = payload.domSnapshot ?? payload.dom_snapshot ?? "";
  const domSnapshot = validateDomSnapshot(domSnapshotValue);
  for (const field of ["endSession", "end_session"]) {
    if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
      throw boundaryError(400, "invalid_payload", `${field} must be boolean`);
    }
  }
  return {
    prompts: payload.prompts,
    domSnapshot,
    endSession: payload.endSession === true || payload.end_session === true,
  };
}

export function validateDomSnapshot(value) {
  return requireString(value, "domSnapshot", DOM_SNAPSHOT_MAX_BYTES);
}

function serializedBytes(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw boundaryError(400, "invalid_payload", `${label} must be JSON serializable`);
  }
  if (serialized === undefined) throw boundaryError(400, "invalid_payload", `${label} is invalid`);
  return utf8Bytes(serialized);
}

function validateWhiteboardScene(value, label) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw boundaryError(400, "invalid_payload", `${label} must be an object or null`);
  if (serializedBytes(value, label) > WHITEBOARD_SERIALIZED_MAX_BYTES) {
    throw boundaryError(413, "payload_too_large", `${label} exceeds 8 MiB serialized`);
  }
  if (value.elements !== undefined && !Array.isArray(value.elements)) {
    throw boundaryError(400, "invalid_payload", `${label}.elements must be an array`);
  }
  if ((value.elements?.length || 0) > WHITEBOARD_ELEMENT_MAX) {
    throw boundaryError(413, "payload_too_large", `${label}.elements exceeds ${WHITEBOARD_ELEMENT_MAX}`);
  }
  if (label === "scene" && value.files !== undefined) {
    if (!isPlainObject(value.files)) throw boundaryError(400, "invalid_payload", "scene.files must be an object");
    if (Object.keys(value.files).length > WHITEBOARD_FILE_MAX) {
      throw boundaryError(413, "payload_too_large", `scene.files exceeds ${WHITEBOARD_FILE_MAX}`);
    }
  }
  return value;
}

function validatePngDataUrl(value) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") throw boundaryError(400, "invalid_payload", "pngDataUrl must be a string");
  const prefix = "data:image/png;base64,";
  if (!value.startsWith(prefix))
    throw boundaryError(400, "invalid_payload", "pngDataUrl must be a base64 PNG data URL");
  const encoded = value.slice(prefix.length);
  const firstPadding = encoded.indexOf("=");
  const content = firstPadding === -1 ? encoded : encoded.slice(0, firstPadding);
  const paddingText = firstPadding === -1 ? "" : encoded.slice(firstPadding);
  let validCharacters = content.length > 0;
  for (let index = 0; validCharacters && index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    validCharacters =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 43 ||
      code === 47;
  }
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    (paddingText !== "" && paddingText !== "=" && paddingText !== "==") ||
    !validCharacters
  ) {
    throw boundaryError(400, "invalid_payload", "pngDataUrl contains malformed base64");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const estimatedBytes = (encoded.length / 4) * 3 - padding;
  if (estimatedBytes > WHITEBOARD_PNG_MAX_BYTES) {
    throw boundaryError(413, "payload_too_large", "decoded PNG exceeds 8 MiB");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length > WHITEBOARD_PNG_MAX_BYTES) {
    throw boundaryError(413, "payload_too_large", "decoded PNG exceeds 8 MiB");
  }
  return value;
}

export function validateWhiteboardSavePayload(payload) {
  if (!isPlainObject(payload)) throw boundaryError(400, "invalid_payload", "request body must be an object");
  const sourceHashValue = payload.source_hash ?? payload.sourceHash ?? "";
  const sourceHash = requireCharacterBoundedString(sourceHashValue, "source hash", SOURCE_HASH_MAX_CHARS);
  const metricsValue = payload.text_metrics_version ?? payload.textMetricsVersion ?? 0;
  if (!Number.isSafeInteger(metricsValue) || metricsValue < 0) {
    throw boundaryError(400, "invalid_payload", "text metrics version must be a non-negative safe integer");
  }
  return {
    sourceHash,
    textMetricsVersion: metricsValue,
    scene: validateWhiteboardScene(payload.scene ?? null, "scene"),
    baseline: validateWhiteboardScene(payload.baseline ?? null, "baseline"),
  };
}

export function validateWhiteboardPublishPayload(payload) {
  if (!isPlainObject(payload)) throw boundaryError(400, "invalid_payload", "request body must be an object");
  return {
    scene: validateWhiteboardScene(payload.scene ?? null, "scene"),
    pngDataUrl: validatePngDataUrl(payload.pngDataUrl ?? payload.png_data_url ?? ""),
  };
}

export function validateContextPath(value, label = "path") {
  return requireString(value, label, CONTEXT_MAX_BYTES);
}

export function validateContextText(value, label = "text") {
  return requireString(value, label, CONTEXT_MAX_BYTES);
}

export function validateBoundedIdentifier(value, label = "identifier") {
  return requireCharacterBoundedString(value, label, TARGET_IDENTIFIER_MAX_CHARS);
}
