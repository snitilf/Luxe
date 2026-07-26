// Brand artwork that has to exist outside CSS.
//
// The design rule is that hex literals live only in `src/luxe-tokens.css`.
// A favicon is the one thing that cannot follow it: it is an SVG data URI in a
// `<link>` tag, so it can neither read a CSS custom property nor be served
// through the stylesheet. These two values are therefore a deliberate,
// single-place mirror of `--dark-fill` and `--canvas`, and
// `test/chrome-design.test.js` fails if they ever drift from the token file.
export const MARK_FIELD = "#463527"; // mirrors --dark-fill (cocoa)
export const MARK_INK = "#f7f4ee"; // mirrors --canvas / --dark-fill-text (ivory)

// A plain cocoa tile with an ivory L. Neutral by intent: the tab icon says
// "this is a Luxe session", not "this is a product with a mascot".
export const LUXE_FAVICON_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>` +
  `<rect width='100' height='100' rx='22' fill='${MARK_FIELD}'/>` +
  `<path d='M38 26v44h26' fill='none' stroke='${MARK_INK}' stroke-width='9' stroke-linecap='round' stroke-linejoin='round'/>` +
  `</svg>`;
