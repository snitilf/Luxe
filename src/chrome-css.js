// How the design tokens reach the browser.
//
// `src/luxe-tokens.css` is the single source of truth for every colour,
// geometry and type value in the product. It is INLINED into the chrome
// stylesheet rather than imported: `chrome.css` is served by one dedicated
// route and copied to `dist/` as a single file, and there is no route and no
// copy step for a tokens file, so `@import "./luxe-tokens.css"` would 404 in
// the browser.
//
// The substitution happens twice, on the same marker:
//   - `scripts/build.js` bakes it into `dist/chrome.css` (what ships)
//   - the `/chrome.css` route does it at request time for source runs, where
//     the served file is `src/chrome.css` and still carries the marker
export const LUXE_TOKENS_MARKER = "/* @luxe-tokens */";

export function inlineLuxeTokens(css, tokens) {
  if (!css.includes(LUXE_TOKENS_MARKER)) {
    throw new Error(`chrome.css is missing the ${LUXE_TOKENS_MARKER} marker; the design tokens would not ship`);
  }
  // A function replacer keeps `$&`-style sequences in the token text literal.
  return css.replace(LUXE_TOKENS_MARKER, () => String(tokens).trimEnd());
}
