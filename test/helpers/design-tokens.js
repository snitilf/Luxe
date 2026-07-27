// Shared reading and colour maths for the token-pinning tests.
//
// `src/luxe-tokens.css` is the single source of truth, and the four files that
// restate its values for a third party are only safe because a test reads the
// token back out of the CSS and compares. That reader, and the WCAG maths the
// contrast floors are measured with, were previously private to
// `test/design-tokens-derived.test.js`. A second test file needing either had
// exactly two options: import from a test file (which re-runs its tests) or
// copy the maths (which is the drift the whole doctrine exists to prevent).
// So they live here, and any test that pins a token uses these.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tokensPromise = readFile(new URL("../../src/luxe-tokens.css", import.meta.url), "utf8");

/** The raw text of src/luxe-tokens.css. */
export function luxeTokensCss() {
  return tokensPromise;
}

/**
 * Read one token's declared value out of `src/luxe-tokens.css`.
 *
 * Dynamic on purpose: a copied expected value keeps passing after the token
 * moves, which is precisely how a pinned guarantee dies silently.
 *
 * @param {string} name token name without the leading `--`
 * @returns {Promise<string>}
 */
export async function token(name) {
  const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(await tokensPromise);
  assert.ok(match, `token --${name} is missing from luxe-tokens.css`);
  return match[1].trim();
}

/**
 * Every token whose name starts with the given prefix, in declaration order.
 * Lets a test sweep a family (`syn-`, `diff-`) instead of restating a list that
 * a later token would silently fall outside of.
 *
 * @param {string} prefix e.g. "syn-"
 * @returns {Promise<{ name: string, value: string }[]>}
 */
export async function tokensWithPrefix(prefix) {
  const css = await tokensPromise;
  const found = [];
  const pattern = new RegExp(`--(${prefix}[a-z0-9-]*)\\s*:\\s*([^;]+);`, "g");
  for (const match of css.matchAll(pattern)) found.push({ name: match[1], value: match[2].trim() });
  return found;
}

/** sRGB hex -> linear-light channels. */
export function linearRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

/** WCAG 2.x relative-luminance contrast ratio between two sRGB hex colours. */
export function wcagContrast(hexA, hexB) {
  const lum = (hex) => {
    const [r, g, b] = linearRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
