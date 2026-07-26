// The Luxe Mermaid theme, in one place.
//
// Mermaid is configured through a JavaScript object, not CSS, so it cannot read
// `var(--canvas)` and friends. The hex literals below are therefore a declared
// exception to the "only luxe-tokens.css carries hex" rule, alongside the
// favicon mark (`luxe-brand.js`), the Shiki theme (`luxe-shiki-theme.js`) and
// the DaisyUI theme block (`design-reference.js`) - every one of them a
// serialized-for-a-third-party surface that cannot reference a CSS variable.
// `test/design-tokens-derived.test.js` pins every value here against the token
// file, so the two can never drift.
//
// A bare `theme:` name is not enough - Mermaid's own defaults ship beige fills
// and purple borders that read as a foreign object dropped into a Luxe page.
// The structural values are `notes/UI-REVAMP.md` section 3, verbatim. The
// series colours below them are section 2.7's chart palette and section 2.6's
// status colours, carried into the diagram variables section 3 does not name;
// see the block comments there and the gotchas entry on silent-spec decisions.
//
// Two call sites import this object rather than restating it:
//   1. `design-reference.js` serializes it into the artifact-facing Mermaid CDN
//      snippet, so every agent-authored diagram inherits the system.
//   2. `whiteboard-frame.js` passes it to `parseMermaidToExcalidraw`, so the
//      converted Excalidraw scene starts in the same palette.
//
// Call site 2 has a consequence that is easy to miss: the converter renders the
// diagram with these variables and Excalidraw measures the resulting text
// synchronously. Changing `fontFamily` or `fontSize` here therefore changes
// glyph metrics for every scene ever saved, which is why
// `WHITEBOARD_TEXT_METRICS_VERSION` must be bumped whenever this block changes.

/**
 * Mermaid `themeVariables`. Exported frozen because both call sites hand it
 * straight to a third-party library that is free to mutate what it is given.
 */
export const LUXE_MERMAID_THEME_VARIABLES = Object.freeze({
  fontFamily: '"Inter", -apple-system, "Segoe UI", sans-serif',
  fontSize: "14px",
  background: "#f7f4ee",
  primaryColor: "#ffffff",
  primaryBorderColor: "#cbc4b2",
  primaryTextColor: "#211e17",
  lineColor: "#5c564a",
  edgeLabelBackground: "#f7f4ee",
  clusterBkg: "#fbf9f4",
  clusterBorder: "#e7e2d6",
  noteBkgColor: "#faf0d8",

  // ---- Series colours: the Bisque palette, section 2.7's fixed order -------
  // Section 3's block sets none of these, and Mermaid's own defaults for them
  // are derived from its stock lilac/lime, so a `pie` rendered with the block
  // above was still the "foreign object dropped into the page" section 3
  // exists to prevent. These are section 2.7's eight slots in their fixed
  // order - the order is the colour-blind safety mechanism, so they are never
  // reshuffled and never cycled. Mermaid asks for twelve; a chart needing more
  // than eight series is past what this palette can carry, and the spec's
  // answer to that is to redesign the chart, not to invent slot nine.
  pie1: "#527dc1",
  pie2: "#b95d4a",
  pie3: "#50a67e",
  pie4: "#d7a44c",
  pie5: "#5a8637",
  pie6: "#ce7d93",
  pie7: "#7660a3",
  pie8: "#d36e4f",
  // Mermaid draws slices at 0.7 opacity and separates them with black strokes.
  // Full opacity is what makes a slice the token value rather than a lightened
  // approximation of it, and the separator is the canvas, matching the 2px
  // surface gap section 2.7 specifies between stacked segments.
  pieOpacity: "1",
  pieStrokeColor: "#f7f4ee",
  pieStrokeWidth: "2px",
  pieOuterStrokeColor: "#cbc4b2",
  // Pie title, section and legend text all fall back to `primaryTextColor`
  // above, so they are already the Luxe ink and need no entry here.

  // ---- Gantt ---------------------------------------------------------------
  // Same problem, different literals: Mermaid's Gantt defaults hard-code
  // "red", "navy", "lightgrey" and "white". Each maps onto an existing token
  // with the same job, so nothing new is invented - the crit colours are the
  // status red from section 2.6, the rules are the hairline, and the surfaces
  // are the paper. Task bars and their borders already inherit `primaryColor`
  // and `primaryBorderColor`.
  sectionBkgColor: "#fbf9f4",
  altSectionBkgColor: "#f7f4ee",
  sectionBkgColor2: "#fbf9f4",
  excludeBkgColor: "#f7f4ee",
  gridColor: "#e7e2d6",
  vertLineColor: "#e7e2d6",
  doneTaskBkgColor: "#f7f4ee",
  doneTaskBorderColor: "#cbc4b2",
  activeTaskBkgColor: "#e9eef5",
  activeTaskBorderColor: "#3c5f8f",
  critBkgColor: "#f9e8e2",
  critBorderColor: "#b3341f",
  // `--ink-2`, the same value as `lineColor`, not the error red Mermaid defaults to.
  // The today marker is a temporal reference meaning "now", not a status meaning
  // "wrong", and section 2.6 reserves status colour for status. Sharing the error
  // red with `critBorderColor` also renders two different meanings in one colour on
  // any chart that has a critical task.
  todayLineColor: "#5c564a",
});

/**
 * The full `mermaid.initialize()` argument for artifact pages. `theme: "base"`
 * is what makes `themeVariables` take effect at all; `securityLevel: "strict"`
 * keeps untrusted diagram text from executing.
 */
export const LUXE_MERMAID_INIT = Object.freeze({
  startOnLoad: false,
  theme: "base",
  securityLevel: "strict",
  themeVariables: LUXE_MERMAID_THEME_VARIABLES,
});

// Excalidraw canvas background for converted scenes (UI-REVAMP section 3).
// Kept here rather than in the frame so the whiteboard and the inline diagram
// sit on the same paper.
export const LUXE_WHITEBOARD_CANVAS_BACKGROUND = "#f7f4ee";

/** Serialize the init object for embedding in a generated <script> snippet. */
export function luxeMermaidInitLiteral(indent = "    ") {
  return JSON.stringify(LUXE_MERMAID_INIT, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : indent + line))
    .join("\n");
}
