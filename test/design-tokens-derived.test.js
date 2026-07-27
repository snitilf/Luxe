// Four surfaces have to hand Luxe colours to a third party as literal values,
// because none of them can read a CSS custom property: the Mermaid config
// object, the Shiki theme JSON, the DaisyUI theme block, and the favicon mark
// (pinned in chrome-design.test.js). This file is what keeps those literals
// from drifting away from `src/luxe-tokens.css`, which stays the single source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LUXE_DAISYUI_THEME_CSS, LUXE_CHART_GUIDANCE } from "../src/design-reference.js";
import { linearRgb, token, wcagContrast } from "./helpers/design-tokens.js";
import { LUXE_SHIKI_THEME } from "../src/luxe-shiki-theme.js";
import {
  LUXE_MERMAID_INIT,
  LUXE_MERMAID_THEME_VARIABLES,
  LUXE_WHITEBOARD_CANVAS_BACKGROUND,
} from "../src/mermaid-theme.js";

// ---- Colour maths -----------------------------------------------------------
// Enough of it to assert the properties the chart palette was selected for. These
// mirror the data-viz skill's validator; they live here rather than being imported
// because that script ships with the skill, not with this repo, and a test may not
// depend on a path that only exists while the skill is loaded.
// `linearRgb`, `token` and `wcagContrast` come from the shared helper; only the
// OKLab/CVD maths below is private to this file.

/** @param {number[]} rgb linear-light sRGB */
function oklab(rgb) {
  const [r, g, b] = rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// Machado, Oliveira & Fernandes (2009) at severity 1.0, applied in linear RGB.
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function simulate(rgb, kind) {
  if (!kind) return rgb;
  return MACHADO[kind].map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]);
}

function oklchLightness(hex) {
  return oklab(linearRgb(hex))[0];
}

function oklchChroma(hex) {
  const [, a, b] = oklab(linearRgb(hex));
  return Math.hypot(a, b);
}

/** Euclidean distance in OKLab, x100, optionally under a simulated CVD. */
function cvdDeltaE(hexA, hexB, kind) {
  const a = oklab(simulate(linearRgb(hexA), kind));
  const b = oklab(simulate(linearRgb(hexB), kind));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
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
    pie1: "#5b85cc",
    pie2: "#874420",
    pie3: "#4bad8e",
    pie4: "#cf8b3b",
    pie5: "#677d12",
    pie6: "#be5b7f",
    pie7: "#73488e",
    pie8: "#9f4f36",
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
    todayLineColor: "#211e17",
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
test("Mermaid series colours are the Café palette in the spec's fixed order", async () => {
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
  // The today marker means "now", not "wrong", so it takes an ink rather than a status
  // colour it would then share with critBorderColor. It also has to be distinguishable
  // from the ordinary rules: at --ink-2 it was the same value as lineColor, so "now" was
  // drawn in the ink used for every axis and edge on the chart.
  assert.equal(variables.todayLineColor, await token("ink-1"));
  assert.notEqual(variables.todayLineColor, variables.critBorderColor);
  assert.notEqual(variables.todayLineColor, variables.lineColor);

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

// The theme's header claims every syntax scope except punctuation clears 4.5:1
// on the code plane. That claim was prose only, so when `--code-bg` was recessed
// from #f7f4ec to #efe9db - the right call, the old plane was invisible against
// the canvas - four scopes silently fell under the bar and nothing failed. This
// test is the claim. It reads the plane and the inks out of `luxe-tokens.css`
// rather than restating them, because a copied expected value is exactly how the
// guarantee died the first time: it would have kept passing against the old
// background.
const SYNTAX_SCOPE_TOKENS = [
  "syn-keyword",
  "syn-string",
  "syn-number",
  "syn-comment",
  "syn-function",
  "syn-type",
  "syn-plain",
];

test("every syntax ink clears 4.5:1 on the code plane", async () => {
  const plane = await token("code-bg");

  for (const name of SYNTAX_SCOPE_TOKENS) {
    const ink = await token(name);
    const ratio = wcagContrast(ink, plane);
    assert.ok(ratio >= 4.5, `--${name} (${ink}) is ${ratio.toFixed(2)}:1 on --code-bg (${plane}), floor is 4.5:1`);
  }

  // The list above is the palette's side of the guarantee. This is the theme's:
  // it sweeps what Shiki will actually paint, so a scope added to the theme
  // later is measured whether or not anyone remembers to name it here. The
  // punctuation entry is the only one allowed to skip, and it is identified by
  // its token value, not by its position in the list.
  const punct = await token("syn-punct");
  for (const entry of LUXE_SHIKI_THEME.tokenColors) {
    const ink = entry.settings.foreground;
    if (ink === punct) continue;
    const ratio = wcagContrast(ink, plane);
    assert.ok(
      ratio >= 4.5,
      `scope ${entry.scope[0]} (${ink}) is ${ratio.toFixed(2)}:1 on --code-bg (${plane}), floor is 4.5:1`,
    );
  }
});

// --syn-punct is the one carve-out, and it is deliberate: punctuation is
// decoration-grade, it may never be the only thing distinguishing two
// constructs, so it is allowed to sit below the text floor. Asserted by name and
// bounded on both sides - if it ever climbs past 4.5 the exception is obsolete
// and should be deleted rather than left as a permanent excuse, and if it sinks
// toward the plane it has stopped being legible at all.
test("punctuation is the one documented exception to the 4.5:1 floor", async () => {
  const plane = await token("code-bg");
  const punct = await token("syn-punct");
  const ratio = wcagContrast(punct, plane);

  assert.ok(ratio < 4.5, `--syn-punct (${punct}) now clears 4.5:1 at ${ratio.toFixed(2)}:1; drop the exception`);
  assert.ok(ratio >= 3, `--syn-punct (${punct}) is only ${ratio.toFixed(2)}:1 on --code-bg (${plane}), floor is 3:1`);
  assert.equal(SYNTAX_SCOPE_TOKENS.includes("syn-punct"), false);

  // And the exception is stated where a reader of the theme will meet it.
  const source = await readFile(new URL("../src/luxe-shiki-theme.js", import.meta.url), "utf8");
  assert.match(source, /[Pp]unctuation is the one exception/);
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

// Mermaid authors diagrams as `<pre class="mermaid">` and then replaces the text content
// with an `<svg>`, so a bare `pre` selector in the code-plane rule paints every diagram on
// the page as a code block. The bug hid for a long time because the fill used to sit only
// two units off the canvas, nearly indistinguishable from it, until the plane was made
// visible and the border-and-fill-around-a-picture became obvious too.
test("the code-plane rule never matches a mermaid diagram", () => {
  // Strip CSS comments first: the selector search below scans back to the previous `}`,
  // and the explanatory comment above the rule is full of prose containing the word
  // "pre" and commas, which would otherwise get swept into the match and split like a
  // selector list.
  const css = LUXE_DAISYUI_THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

  // Find the selector list for the declaration block that sets the code plane's
  // background (the fill + border block, not the font-family reset above it).
  const ruleMatch = /([^{}]*\bpre\b[^{}]*)\{\s*background:/.exec(css);
  assert.ok(
    ruleMatch,
    "could not find a `pre`-matching rule that sets a background - has the code-plane rule moved or been renamed?",
  );

  const selectorList = ruleMatch[1];
  const selectors = selectorList.split(",").map((s) => s.trim());
  const preSelectors = selectors.filter((s) => /\bpre\b/.test(s));
  assert.ok(preSelectors.length > 0, "no `pre` compound found in the code-plane selector list");

  for (const selector of preSelectors) {
    assert.match(
      selector,
      /pre:not\(\.mermaid\)/,
      `the code-plane selector "${selector}" matches a bare <pre>, which means it will also match ` +
        `<pre class="mermaid">. Mermaid replaces that element's text with an <svg>, so this rule ` +
        `will paint every diagram on the page with an inset background and border, framing pictures ` +
        `as code blocks. Exclude mermaid explicitly, e.g. "pre:not(.mermaid)".`,
    );
  }
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

// The literals above only prove the four copies agree. These pin the properties the
// palette was actually selected for, so a future "let's soften it a bit" is caught by a
// failing test rather than by a reader who cannot tell two series apart. Thresholds are
// the data-viz skill's: OKLCH chroma floor 0.10, adjacent CVD target ΔE 8, normal-vision
// floor ΔE 15, non-text contrast 3:1.
test("the chart palette holds the properties it was measured against", async () => {
  const palette = [];
  for (let slot = 1; slot <= 8; slot += 1) palette.push(await token(`chart-${slot}`));

  for (const hex of palette) {
    assert.ok(oklchChroma(hex) >= 0.1, `${hex} is under the chroma floor and reads grey`);
    const L = oklchLightness(hex);
    assert.ok(L >= 0.43 && L <= 0.77, `${hex} is outside the lightness band at L ${L.toFixed(3)}`);
  }

  for (let i = 0; i < palette.length - 1; i += 1) {
    const pair = `${palette[i]}<->${palette[i + 1]}`;
    for (const kind of ["protan", "deutan"]) {
      const separation = cvdDeltaE(palette[i], palette[i + 1], kind);
      assert.ok(separation >= 8, `${pair} only separates by ΔE ${separation.toFixed(1)} under ${kind}`);
    }
    const normal = cvdDeltaE(palette[i], palette[i + 1], null);
    assert.ok(normal >= 15, `${pair} only separates by ΔE ${normal.toFixed(1)} under normal vision`);
  }

  // Exactly two slots are allowed under 3:1 on the canvas, and the labelling rule is what
  // carries them. If a third ever drops under, the rule's own wording is wrong too.
  const canvas = await token("canvas");
  const lowContrast = palette.filter((hex) => wcagContrast(hex, canvas) < 3);
  assert.equal(lowContrast.length, 2, `expected 2 slots under 3:1, found ${lowContrast.join(", ")}`);
  assert.match(LUXE_CHART_GUIDANCE.labelling_rule, /Two of the eight/);
});

test("the sequential ramp is visible on the canvas it is drawn on", async () => {
  const sequential = [];
  for (let slot = 1; slot <= 5; slot += 1) sequential.push(await token(`seq-${slot}`));
  const canvas = await token("canvas");

  // The ramp this replaced opened on #dbe4f4 at 1.17:1, so the lowest band of every
  // heatmap was invisible against the page.
  assert.ok(wcagContrast(sequential[0], canvas) >= 2, `the lightest step ${sequential[0]} is under 2:1 on the canvas`);
  for (let i = 0; i < sequential.length - 1; i += 1) {
    const drop = oklchLightness(sequential[i]) - oklchLightness(sequential[i + 1]);
    assert.ok(drop >= 0.06, `steps ${i + 1}->${i + 2} differ by only ΔL ${drop.toFixed(3)}`);
  }
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
