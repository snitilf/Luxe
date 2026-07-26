export const MAX_LAYOUT_WARNINGS = 50;
export const MAX_LAYOUT_SELECTOR_CHARACTERS = 512;

export const LAYOUT_WARNING_DESCRIPTIONS = Object.freeze({
  "page-horizontal-overflow": "The page reports horizontal overflow.",
  "clipped-text": "Text reports clipping inside its visible boundary.",
  "viewport-unreachable-content": "Content reports that it is unreachable within the viewport.",
  "clipped-control": "A required control reports clipping inside an ancestor boundary.",
  "viewport-unreachable-control": "A required control reports that it is unreachable within the viewport.",
  "overlapping-text": "Text reports near-total overlap by another element.",
});

const LAYOUT_WARNING_KINDS = new Set(Object.keys(LAYOUT_WARNING_DESCRIPTIONS));
const SELECTOR_SEGMENT = "[a-z][a-z0-9-]*(#[A-Za-z_][A-Za-z0-9_-]{0,127})?(:nth-of-type\\([1-9][0-9]{0,5}\\))?";
export const LAYOUT_SELECTOR_PATTERN = new RegExp(`^${SELECTOR_SEGMENT}( > ${SELECTOR_SEGMENT}){0,4}$`);

export class LayoutWarningValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LayoutWarningValidationError";
    this.status = 400;
  }
}

export function normalizeLayoutWarningReport(value) {
  if (!Array.isArray(value)) {
    throw new LayoutWarningValidationError("layout_warnings must be an array");
  }
  if (value.length > MAX_LAYOUT_WARNINGS) {
    throw new LayoutWarningValidationError(`layout_warnings must contain at most ${MAX_LAYOUT_WARNINGS} entries`);
  }

  return value.map((warning, index) => {
    if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
      throw new LayoutWarningValidationError(`layout_warnings[${index}] must be an object`);
    }
    const selector = warning.selector;
    if (
      typeof selector !== "string" ||
      selector.length > MAX_LAYOUT_SELECTOR_CHARACTERS ||
      !LAYOUT_SELECTOR_PATTERN.test(selector)
    ) {
      throw new LayoutWarningValidationError(`layout_warnings[${index}].selector is invalid`);
    }
    if (typeof warning.kind !== "string" || !LAYOUT_WARNING_KINDS.has(warning.kind)) {
      throw new LayoutWarningValidationError(`layout_warnings[${index}].kind is invalid`);
    }
    if (warning.severity !== "error") {
      throw new LayoutWarningValidationError(`layout_warnings[${index}].severity must be error`);
    }
    if (warning.axis !== "horizontal" && warning.axis !== "vertical") {
      throw new LayoutWarningValidationError(`layout_warnings[${index}].axis is invalid`);
    }
    if (typeof warning.overflowPx !== "number" || !Number.isFinite(warning.overflowPx) || warning.overflowPx < 0) {
      throw new LayoutWarningValidationError(`layout_warnings[${index}].overflowPx is invalid`);
    }
    return {
      selector,
      kind: warning.kind,
      severity: "error",
      axis: warning.axis,
      overflowPx: warning.overflowPx,
    };
  });
}
