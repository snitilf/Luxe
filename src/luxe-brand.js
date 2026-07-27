// Brand artwork that has to exist outside CSS.
//
// The design rule is that hex literals live only in `src/luxe-tokens.css`.
// A favicon is the one thing that cannot follow it: it is an SVG data URI in a
// `<link>` tag, so it can neither read a CSS custom property nor be served
// through the stylesheet. These two values are therefore a deliberate,
// single-place mirror of `--canvas` and `--dark-fill`, and
// `test/chrome-design.test.js` fails if they ever drift from the token file.
//
// The mark inverted in July 2026: it was a solid cocoa tile with an ivory sans
// L, and is now an ivory tile with a cocoa keyline and a serif L, matching the
// Newsreader wordmark beside it in the toolbar. The geometry is a faithful
// transcription of `notes/logo-concepts/favicon-keyline.svg` - same viewBox,
// same rect, same rx, same stroke-width, same path data - reformatted only for
// the data-URI constraints described below, never redrawn.
export const MARK_PAPER = "#f7f4ee"; // mirrors --canvas (ivory)
export const MARK_COCOA = "#463527"; // mirrors --dark-fill (cocoa)

// An ivory tile, a 2px cocoa keyline, and a serif L. The keyline reads as a
// pressed edge rather than a filled chip, which is why the tile is inset by 2
// on a 32 grid: at 16px the stroke needs the whole pixel it sits on.
export const LUXE_FAVICON_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
  `<rect x='2' y='2' width='28' height='28' rx='6' fill='${MARK_PAPER}' stroke='${MARK_COCOA}' stroke-width='2'/>` +
  `<path d='M8.5 7.25H17V8.35L14.8 8.95V21.4H20.25C22.15 21.4 23.05 20.45 23.85 18.7L25 19.05L24.05 24H8.5V22.9L11.4 22.2V8.95L8.5 8.35Z' fill='${MARK_COCOA}'/>` +
  `</svg>`;
