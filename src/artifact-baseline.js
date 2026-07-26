// How the artifact baseline reaches an artifact.
//
// `src/artifact-baseline.css` is the ONLY copy of these rules. It is read here, its
// token marker substituted, and the result handed to three consumers:
//
//   A. runtime  - embedded into `/sdk.js` and injected as <style id="luxe-baseline">,
//                 which is what reaches artifacts that already exist
//   B. authoring - printed by `luxe design` as `baseline_snippet`, so a new artifact
//                 carries the rules itself and still has them when opened standalone
//   C. export   - injected into the HTML the export reads off disk
//
// C exists because the export does NOT see A. `buildSelfContainedHtml` is handed the
// artifact file read from disk (src/server.js), never a snapshot of the live DOM, and
// the SDK script tag is stripped from the output - so a style the SDK injected at
// runtime cannot possibly appear in an export. That was worth checking rather than
// assuming: the obvious reading is that the export "just picks it up", and it does not.
//
// A test asserts all three carry byte-identical rule text, which is what makes "one
// source" true rather than aspirational.
import { readFile } from "node:fs/promises";

export const BASELINE_TOKENS_MARKER = "/* @luxe-baseline-tokens */";
export const BASELINE_STYLE_ID = "luxe-baseline";
export const BASELINE_OPT_OUT_ATTRIBUTE = "data-luxe-baseline";

// Namespaced name -> token name in src/luxe-tokens.css. Namespaced because this lands
// in a document Luxe does not own, and defining `--canvas` or `--dark-fill` on an
// arbitrary artifact's :root would silently retheme any artifact using those names.
const BASELINE_TOKENS = [
  ["--luxe-bl-scroll-thumb", "scrollbar-thumb"],
  ["--luxe-bl-scroll-thumb-hover", "scrollbar-thumb-hover"],
  ["--luxe-bl-scroll-size", "scrollbar-size"],
  ["--luxe-bl-scroll-radius", "radius-pill"],
  ["--luxe-bl-on-dark-code-bg", "on-dark-code-bg"],
  ["--luxe-bl-on-dark-mark-bg", "on-dark-mark-bg"],
  ["--luxe-bl-on-dark-ink", "dark-fill-text"],
];

function readToken(tokensCss, name) {
  const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(tokensCss);
  if (!match) throw new Error(`the artifact baseline needs token --${name}, which luxe-tokens.css does not define`);
  return match[1].trim();
}

/**
 * Substitute the namespaced token block into the baseline stylesheet. Mirrors
 * `inlineLuxeTokens` in src/chrome-css.js, but emits only the handful of values the
 * baseline uses, under `--luxe-bl-*` names, instead of the whole `:root` block.
 *
 * @param {string} css the contents of src/artifact-baseline.css
 * @param {string} tokensCss the contents of src/luxe-tokens.css
 */
export function inlineBaselineTokens(css, tokensCss) {
  if (!css.includes(BASELINE_TOKENS_MARKER)) {
    throw new Error(`artifact-baseline.css is missing the ${BASELINE_TOKENS_MARKER} marker; it would ship unthemed`);
  }
  const declarations = BASELINE_TOKENS.map(([alias, token]) => `${alias}: ${readToken(tokensCss, token)};`).join(
    "\n    ",
  );
  return css.replace(BASELINE_TOKENS_MARKER, () => declarations);
}

/** The baseline stylesheet with its tokens resolved, ready for any of the three channels. */
export async function readArtifactBaselineCss(
  baselineUrl = new URL("./artifact-baseline.css", import.meta.url),
  tokensUrl = new URL("./luxe-tokens.css", import.meta.url),
) {
  const [css, tokens] = await Promise.all([readFile(baselineUrl, "utf8"), readFile(tokensUrl, "utf8")]);
  return inlineBaselineTokens(css, tokens);
}

/**
 * Channel B and C both need the rules as a `<style>` block. The id is what makes the
 * injection idempotent: an artifact that pasted the snippet already carries this id, so
 * the SDK and the export both skip rather than adding a second copy.
 */
export function baselineStyleTag(css) {
  return `<style id="${BASELINE_STYLE_ID}">\n${css.trim()}\n</style>`;
}

/** Whether an artifact's HTML has already opted out or already carries the baseline. */
export function artifactDeclinesBaseline(html) {
  const head = String(html || "").slice(0, 10000);
  if (new RegExp(`${BASELINE_OPT_OUT_ATTRIBUTE}\\s*=\\s*["']?off`, "i").test(head)) return true;
  return new RegExp(`id\\s*=\\s*["']?${BASELINE_STYLE_ID}`, "i").test(String(html || ""));
}
