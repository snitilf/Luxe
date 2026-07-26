// The bespoke Shiki theme `notes/UI-REVAMP.md` section 2.9 mandates.
//
// Shiki takes a TextMate theme as JSON, so - like the Mermaid block - it cannot
// reference the CSS custom properties. Every colour below is a verbatim copy of
// a token in `luxe-tokens.css`, pinned by `test/design-tokens-derived.test.js`.
//
// Design notes carried over from the spec:
//   - the code plane is `--code-bg` (#f7f4ec), not the page canvas, so a code
//     block reads as an inset surface rather than as more paper;
//   - every syntax token except punctuation clears 4.5:1 on that plane, and
//     they are all darks, so they survive on the added and removed diff tints;
//   - punctuation is decoration-grade on purpose. It must never be the only
//     thing distinguishing two constructs.
//
// Ten of section 2.9's eleven colours are below. The eleventh, the hunk-header
// background `--diff-hunk-bg` (#f2ecd9), has no representation here and cannot
// have one: a TextMate theme colours text through scopes and surfaces through a
// closed set of `editor.*`/`diffEditor.*` keys, and that set has no hunk-header
// range. Shiki paints the header's *text* from the `meta.diff.range` scope
// below; the band behind it is a decoration the renderer draws, so the token is
// applied in CSS (`--diff-hunk-bg` in `luxe-tokens.css`) by whoever renders the
// diff, not by this theme.
//
// The nearest thing in spirit is `vitesse-light`; this is not derived from it.

export const LUXE_SHIKI_THEME = Object.freeze({
  name: "luxe",
  displayName: "Luxe",
  type: "light",
  semanticHighlighting: true,
  colors: {
    "editor.background": "#f7f4ec",
    "editor.foreground": "#2c2921",
    "editorLineNumber.foreground": "#8a8375",
    "editorLineNumber.activeForeground": "#5c564a",
    "editor.selectionBackground": "rgba(230, 168, 32, 0.28)",
    "editorGutter.addedBackground": "#c9dfb2",
    "editorGutter.deletedBackground": "#eec4b8",
    "diffEditor.insertedTextBackground": "#e8f1dd",
    "diffEditor.removedTextBackground": "#f9e6e0",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "#746b56", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "keyword.control",
        "keyword.operator.expression",
        "keyword.operator.new",
        "storage",
        "storage.type",
        "storage.modifier",
        "variable.language",
        "constant.language",
      ],
      settings: { foreground: "#963f8b" },
    },
    {
      scope: ["string", "string.quoted", "string.template", "constant.character", "constant.other.symbol"],
      settings: { foreground: "#4a7a2a" },
    },
    {
      scope: ["constant.numeric", "constant.language.boolean", "constant.language.null", "constant.other"],
      settings: { foreground: "#9a5b06" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call", "variable.function"],
      settings: { foreground: "#2f5e9e" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.type",
        "support.class",
        "entity.name.tag",
      ],
      settings: { foreground: "#b8511f" },
    },
    {
      scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
      settings: { foreground: "#7a7466" },
    },
    {
      scope: ["variable", "variable.other", "meta.definition.variable", "source", "text"],
      settings: { foreground: "#2c2921" },
    },
    {
      scope: ["markup.inserted", "meta.diff.header.to-file"],
      settings: { foreground: "#2e6b27" },
    },
    {
      scope: ["markup.deleted", "meta.diff.header.from-file"],
      settings: { foreground: "#b3341f" },
    },
    {
      scope: ["meta.diff.range", "punctuation.definition.range.diff"],
      settings: { foreground: "#5c564a" },
    },
  ],
});

/** The theme as pretty JSON, for pasting into an artifact's Shiki setup. */
export function luxeShikiThemeJson() {
  return JSON.stringify(LUXE_SHIKI_THEME, null, 2);
}
