// Four surfaces have to hand Luxe colours to a third party as literal values,
// because none of them can read a CSS custom property: the Mermaid config
// object, the Shiki theme JSON, the DaisyUI theme block, and the favicon mark
// (pinned in chrome-design.test.js). This file is what keeps those literals
// from drifting away from `src/luxe-tokens.css`, which stays the single source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LUXE_DAISYUI_THEME_CSS, LUXE_CHART_GUIDANCE } from "../src/design-reference.js";
import { LUXE_SHIKI_THEME } from "../src/luxe-shiki-theme.js";
import {
  LUXE_MERMAID_INIT,
  LUXE_MERMAID_THEME_VARIABLES,
  LUXE_WHITEBOARD_CANVAS_BACKGROUND,
} from "../src/mermaid-theme.js";

const tokensPromise = readFile(new URL("../src/luxe-tokens.css", import.meta.url), "utf8");

async function token(name) {
  const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(await tokensPromise);
  assert.ok(match, `token --${name} is missing from luxe-tokens.css`);
  return match[1].trim();
}

// notes/UI-REVAMP.md section 3, verbatim. A bare `theme:` name is not enough -
// Mermaid's own defaults ship beige fills and purple borders.
test("the Mermaid theme block is the spec's values and nothing else", async () => {
  assert.deepEqual(LUXE_MERMAID_THEME_VARIABLES, {
    // Section 3, verbatim.
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
    // Section 2.7's palette and section 2.6's status colours, carried into the
    // series variables section 3 does not name. Pinned key by key below.
    pie1: "#527dc1",
    pie2: "#b95d4a",
    pie3: "#50a67e",
    pie4: "#d7a44c",
    pie5: "#5a8637",
    pie6: "#ce7d93",
    pie7: "#7660a3",
    pie8: "#d36e4f",
    pieOpacity: "1",
    pieStrokeColor: "#f7f4ee",
    pieStrokeWidth: "2px",
    pieOuterStrokeColor: "#cbc4b2",
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
    todayLineColor: "#5c564a",
  });

  assert.equal(LUXE_MERMAID_THEME_VARIABLES.background, await token("canvas"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.primaryColor, await token("surface-2"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.primaryBorderColor, await token("strong"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.primaryTextColor, await token("ink-1"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.lineColor, await token("ink-2"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.edgeLabelBackground, await token("canvas"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.clusterBkg, await token("surface-1"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.clusterBorder, await token("hair"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.noteBkgColor, await token("warning-bg"));
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.fontSize, await token("text-label"));

  // The annotation gold is reserved for annotation. It must never reach a
  // diagram as a shape colour (UI-REVAMP section 3).
  const gold = await token("gold");
  assert.equal(
    Object.values(/** @type {Record<string, string>} */ (LUXE_MERMAID_THEME_VARIABLES)).includes(gold),
    false,
  );
});

// Section 3's block sets no series variables, so a `pie` used to render in
// Mermaid's own lilac/lime - exactly the "foreign object dropped into the page"
// section 3 exists to prevent. The eight slots go in section 2.7's FIXED order:
// the order is the colour-blind safety mechanism, so a reshuffle here is a
// correctness bug, not a preference.
test("Mermaid series colours are the Bisque palette in the spec's fixed order", async () => {
  const variables = /** @type {Record<string, string>} */ (LUXE_MERMAID_THEME_VARIABLES);
  for (let slot = 1; slot <= 8; slot += 1) {
    assert.equal(variables[`pie${slot}`], await token(`chart-${slot}`), `pie${slot} is not chart slot ${slot}`);
  }
  // Mermaid asks for twelve. Nine and up are deliberately unset: the palette is
  // never cycled, so a chart needing more than eight series is a chart to
  // redesign, not a slot to invent.
  for (let slot = 9; slot <= 12; slot += 1) assert.equal(variables[`pie${slot}`], undefined);

  // Full opacity is what makes a slice the token value rather than a lightened
  // approximation; the separator is the canvas, matching the 2px surface gap
  // section 2.7 specifies between stacked segments.
  assert.equal(variables.pieOpacity, "1");
  assert.equal(variables.pieStrokeColor, await token("canvas"));
  assert.equal(variables.pieStrokeWidth, await token("chart-stack-gap"));
  assert.equal(variables.pieOuterStrokeColor, await token("strong"));
});

// Mermaid's Gantt defaults hard-code "red", "navy", "lightgrey" and "white".
// Each maps onto the token with the same job, so no new colour is invented.
test("Mermaid Gantt colours are tokens, never Mermaid's red/navy/lightgrey", async () => {
  const variables = /** @type {Record<string, string>} */ (LUXE_MERMAID_THEME_VARIABLES);
  assert.equal(variables.sectionBkgColor, await token("surface-1"));
  assert.equal(variables.sectionBkgColor2, await token("surface-1"));
  assert.equal(variables.altSectionBkgColor, await token("canvas"));
  assert.equal(variables.excludeBkgColor, await token("canvas"));
  assert.equal(variables.gridColor, await token("hair"));
  assert.equal(variables.vertLineColor, await token("hair"));
  assert.equal(variables.doneTaskBkgColor, await token("canvas"));
  assert.equal(variables.doneTaskBorderColor, await token("strong"));
  assert.equal(variables.activeTaskBkgColor, await token("info-bg"));
  assert.equal(variables.activeTaskBorderColor, await token("info-fg"));
  assert.equal(variables.critBkgColor, await token("error-bg"));
  assert.equal(variables.critBorderColor, await token("error-fg"));
  // The today marker means "now", not "wrong", so it takes the neutral line ink
  // rather than a status colour it would then share with critBorderColor.
  assert.equal(variables.todayLineColor, await token("ink-2"));
  assert.notEqual(variables.todayLineColor, variables.critBorderColor);

  for (const value of Object.values(variables)) {
    assert.doesNotMatch(value, /^(red|navy|white|black|lightgrey|grey)$/i, `${value} is a Mermaid default literal`);
  }
});

test("the Mermaid init is what makes themeVariables take effect, and is frozen", () => {
  assert.equal(LUXE_MERMAID_INIT.theme, "base");
  assert.equal(LUXE_MERMAID_INIT.securityLevel, "strict");
  assert.equal(LUXE_MERMAID_INIT.startOnLoad, false);
  assert.equal(LUXE_MERMAID_INIT.themeVariables, LUXE_MERMAID_THEME_VARIABLES);
  // Both are handed straight to third-party libraries that are free to mutate
  // what they are given.
  assert.ok(Object.isFrozen(LUXE_MERMAID_INIT));
  assert.ok(Object.isFrozen(LUXE_MERMAID_THEME_VARIABLES));
});

test("the converted whiteboard canvas is the same paper as the page", async () => {
  assert.equal(LUXE_WHITEBOARD_CANVAS_BACKGROUND, await token("canvas"));
  assert.equal(LUXE_WHITEBOARD_CANVAS_BACKGROUND, LUXE_MERMAID_THEME_VARIABLES.background);
});

test("the theme block is imported by both call sites, never duplicated", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");
  const design = await readFile(new URL("../src/design-reference.js", import.meta.url), "utf8");

  assert.match(frame, /from "\.\/mermaid-theme\.js"/);
  assert.match(design, /from "\.\/mermaid-theme\.js"/);
  // A duplicated block would show up as a second copy of the one value that
  // appears nowhere else in the palette.
  for (const [file, source] of [
    ["whiteboard-frame.js", frame],
    ["design-reference.js", design],
  ]) {
    assert.equal(
      (source.match(/edgeLabelBackground/g) || []).length,
      0,
      `${file} restates the Mermaid theme instead of importing it`,
    );
  }
});

// UI-REVAMP 2.9. Every token is a dark, so all of them survive on the added and
// removed diff tints; punctuation is the one decoration-grade exception.
test("the Shiki theme is built from the code-plane tokens", async () => {
  assert.equal(LUXE_SHIKI_THEME.type, "light");
  assert.equal(LUXE_SHIKI_THEME.colors["editor.background"], await token("code-bg"));
  assert.equal(LUXE_SHIKI_THEME.colors["editor.foreground"], await token("syn-plain"));
  assert.equal(LUXE_SHIKI_THEME.colors["editor.selectionBackground"], await token("gold-wash"));
  assert.equal(LUXE_SHIKI_THEME.colors["editorGutter.addedBackground"], await token("diff-add-gutter"));
  assert.equal(LUXE_SHIKI_THEME.colors["editorGutter.deletedBackground"], await token("diff-rem-gutter"));
  assert.equal(LUXE_SHIKI_THEME.colors["diffEditor.insertedTextBackground"], await token("diff-add-bg"));
  assert.equal(LUXE_SHIKI_THEME.colors["diffEditor.removedTextBackground"], await token("diff-rem-bg"));

  const foreground = (scope) =>
    LUXE_SHIKI_THEME.tokenColors.find((entry) => entry.scope.includes(scope))?.settings.foreground;
  assert.equal(foreground("keyword"), await token("syn-keyword"));
  assert.equal(foreground("string"), await token("syn-string"));
  assert.equal(foreground("constant.numeric"), await token("syn-number"));
  assert.equal(foreground("comment"), await token("syn-comment"));
  assert.equal(foreground("entity.name.function"), await token("syn-function"));
  assert.equal(foreground("entity.name.type"), await token("syn-type"));
  assert.equal(foreground("punctuation"), await token("syn-punct"));
  assert.equal(foreground("variable"), await token("syn-plain"));
  assert.equal(foreground("markup.inserted"), await token("success-fg"));
  assert.equal(foreground("markup.deleted"), await token("error-fg"));
});

// Ten of section 2.9's eleven colours are in the theme. The eleventh, the
// hunk-header background, cannot be: a TextMate theme colours text through
// scopes and surfaces through a closed set of keys, and there is no hunk-header
// range in that set. An unrepresentable spec value has to be recorded as such,
// or the next reader reads the gap as an oversight and "fixes" it with an
// invented key Shiki ignores.
test("the one section 2.9 value the Shiki theme cannot carry is recorded as such", async () => {
  const source = await readFile(new URL("../src/luxe-shiki-theme.js", import.meta.url), "utf8");
  const hunk = await token("diff-hunk-bg");

  assert.match(source, /--diff-hunk-bg/, "the unmapped hunk-header token is not mentioned");
  assert.ok(source.includes(hunk), "the note does not name the value it is about");
  assert.match(source, /cannot/, "the note does not say the value cannot be represented");
  // And it really is absent from the theme rather than smuggled in somewhere.
  assert.equal(JSON.stringify(LUXE_SHIKI_THEME).includes(hunk), false);
});

// D1. One file maps DaisyUI's semantic variables onto Luxe tokens; the upstream
// catalogue and build stay intact.
test("the DaisyUI theme block maps onto the Luxe tokens", async () => {
  const value = (name) => {
    const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(LUXE_DAISYUI_THEME_CSS);
    assert.ok(match, `${name} is missing from the DaisyUI theme block`);
    return match[1].trim();
  };

  assert.equal(value("color-base-100"), await token("surface-2"));
  assert.equal(value("color-base-200"), await token("surface-1"));
  assert.equal(value("color-base-300"), await token("canvas"));
  assert.equal(value("color-base-content"), await token("ink-1"));
  assert.equal(value("color-primary"), await token("dark-fill"));
  assert.equal(value("color-primary-content"), await token("dark-fill-text"));
  assert.equal(value("color-secondary"), await token("ink-2"));
  assert.equal(value("color-info"), await token("info-fg"));
  assert.equal(value("color-success"), await token("success-fg"));
  assert.equal(value("color-warning"), await token("warning-fg"));
  assert.equal(value("color-error"), await token("error-fg"));
  assert.equal(value("radius-selector"), await token("radius-pill"));
  assert.equal(value("radius-field"), await token("radius-nav"));
  assert.equal(value("radius-box"), await token("radius-card"));

  // The one accent is reserved. Leaving the gold reachable through btn-accent
  // would spend it on ordinary buttons.
  assert.equal(value("color-accent"), await token("dark-fill-hover"));
  assert.equal(LUXE_DAISYUI_THEME_CSS.includes(await token("gold")), false);
  assert.match(LUXE_DAISYUI_THEME_CSS, /color-scheme: light/);
  assert.doesNotMatch(LUXE_DAISYUI_THEME_CSS, /prefers-color-scheme/);
});

test("the chart guidance is the token palette in the spec's fixed order", async () => {
  const palette = [];
  for (let slot = 1; slot <= 8; slot += 1) palette.push(await token(`chart-${slot}`));
  assert.deepEqual(LUXE_CHART_GUIDANCE.palette, palette);

  const sequential = [];
  for (let slot = 1; slot <= 5; slot += 1) sequential.push(await token(`seq-${slot}`));
  assert.deepEqual(LUXE_CHART_GUIDANCE.sequential, sequential);

  const diverging = [];
  for (let slot = 1; slot <= 7; slot += 1) diverging.push(await token(`div-${slot}`));
  assert.deepEqual(LUXE_CHART_GUIDANCE.diverging, diverging);
});

// Done-criterion: no "dark" string literals in shipped guidance. The check is
// against what an agent actually receives, not against the source text - the
// source is allowed to say in a comment why the dark path was deleted, and it
// should, or the next reader re-adds it.
test("nothing an agent receives mentions dark mode or the OS theme", async () => {
  const { createDesignOutput } = await import("../src/design-reference.js");
  const { PLAYBOOKS, PLAYBOOK_ROUTER_INSTRUCTION } = await import("../src/playbooks.js");
  const shipped = JSON.stringify({
    design: createDesignOutput(),
    playbooks: PLAYBOOKS,
    router: PLAYBOOK_ROUTER_INSTRUCTION,
  });

  assert.doesNotMatch(shipped, /\bdark\b/i, "shipped guidance still mentions dark mode");
  assert.doesNotMatch(shipped, /prefers-color-scheme/, "shipped guidance still branches on the OS theme");
  assert.doesNotMatch(shipped, /data-theme="(?!luxe")/, "shipped guidance still names a non-Luxe theme");
  // And the light system is prescribed positively, not merely by omission.
  assert.match(shipped, /exactly one theme and it is light/);
});
