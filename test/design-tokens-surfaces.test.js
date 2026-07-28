// Two holes in the token doctrine's safety net, closed.
//
// The doctrine: `src/luxe-tokens.css` is the single source of truth and the only
// file where a hex literal may originate. Four files are allowed to restate a
// token value because they are serialized for a third party that cannot read a
// CSS custom property - and every restated value is PINNED back against the
// token file by a test, which is the only reason "restated" is not "drifted".
//
// Hole 1: the DaisyUI theme block's code-plane rule gained `background: #efe9db`
// and `border: 1px solid #cbc4b2` with no pin, alongside a dozen `*-content` and
// body values that never had one. Two foreign colours could be dropped into the
// artifact-facing stylesheet with the whole suite staying green. Pinned below,
// declaration by declaration, plus a sweep that fails on any hex in the block
// that is not a token value - so the next unpinned literal fails on arrival
// rather than waiting for a reviewer to notice it.
//
// Hole 2: the syntax inks were darkened so every non-punctuation scope clears
// 4.5:1, and that was enforced on `--code-bg` only. The same inks render on the
// three diff surfaces too, which are not derived from `--code-bg` and are free
// to move independently; the floor held there by luck rather than by a test.
// Enforced below on every surface the inks actually render on.
import assert from "node:assert/strict";
import test from "node:test";

import { LUXE_DAISYUI_THEME_CSS } from "../src/design-reference.js";
import { LUXE_SHIKI_THEME } from "../src/luxe-shiki-theme.js";
import { token, tokensWithPrefix, wcagContrast } from "./helpers/design-tokens.js";

// ---- The DaisyUI theme block ------------------------------------------------

// Comments first: the block's prose names colours and selectors, and both the
// rule scan and the hex sweep below would otherwise read documentation as CSS.
const themeCss = LUXE_DAISYUI_THEME_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { body }` pair in the block, in source order. */
function themeRules() {
  return [...themeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

function ruleBody(predicate, what) {
  const rule = themeRules().find((entry) => predicate(entry));
  assert.ok(rule, `could not find the ${what} in the DaisyUI theme block - has it moved or been renamed?`);
  return rule.body;
}

function declaration(body, property, what) {
  const match = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(body);
  assert.ok(match, `the ${what} rule does not set \`${property}\``);
  return match[1].trim();
}

const hexesIn = (css) => (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((hex) => hex.toLowerCase());

// Every custom property in the theme block, and the token it restates. The map is
// exhaustive by construction: the sweep at the end of this test fails if the block
// carries a hex that is not one of these tokens' values.
const DAISYUI_PROPERTY_PINS = [
  ["color-base-100", "surface-2"],
  ["color-base-200", "surface-1"],
  ["color-base-300", "canvas"],
  ["color-base-content", "ink-1"],
  ["color-primary", "dark-fill"],
  ["color-primary-content", "dark-fill-text"],
  ["color-secondary", "ink-2"],
  ["color-secondary-content", "dark-fill-text"],
  ["color-accent", "dark-fill-hover"],
  ["color-accent-content", "dark-fill-text"],
  ["color-neutral", "ink-1"],
  ["color-neutral-content", "dark-fill-text"],
  ["color-info", "info-fg"],
  ["color-info-content", "dark-fill-text"],
  ["color-success", "success-fg"],
  ["color-success-content", "dark-fill-text"],
  ["color-warning", "warning-fg"],
  ["color-warning-content", "dark-fill-text"],
  ["color-error", "error-fg"],
  ["color-error-content", "dark-fill-text"],
];

test("every colour the DaisyUI theme block restates is pinned to its token", async () => {
  const property = (name) => {
    const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(themeCss);
    assert.ok(match, `--${name} is missing from the DaisyUI theme block`);
    return match[1].trim();
  };

  for (const [name, tokenName] of DAISYUI_PROPERTY_PINS) {
    const expected = await token(tokenName);
    assert.equal(
      property(name),
      expected,
      `the DaisyUI theme's --${name} is ${property(name)}, but it restates --${tokenName} (${expected})`,
    );
  }

  // The page plane. `body` is pinned to the canvas explicitly rather than
  // inherited, so it is a restated value like any other.
  const page = ruleBody((rule) => /\bbody\b/.test(rule.selector) && /background\s*:/.test(rule.body), "html/body rule");
  const canvas = await token("canvas");
  const ink1 = await token("ink-1");
  assert.equal(
    declaration(page, "background", "html/body"),
    canvas,
    `the DaisyUI theme's page background must be --canvas (${canvas})`,
  );
  assert.equal(declaration(page, "color", "html/body"), ink1, `the DaisyUI theme's page ink must be --ink-1 (${ink1})`);

  // The code plane: an inset surface drawn in --code-bg and bordered in --strong.
  // These were the two unpinned values. Nothing objected when they were swapped
  // for #f0f0f0 and #999999 - the design lint passed, the mapping test passed,
  // the suite stayed green - so two foreign colours could reach the stylesheet
  // artifacts are told to paste.
  const plane = ruleBody(
    (rule) => /\bpre\b/.test(rule.selector) && /background\s*:/.test(rule.body),
    "code-plane rule",
  );
  const codeBg = await token("code-bg");
  const strong = await token("strong");
  const hairline = await token("stroke-hair");

  assert.equal(
    declaration(plane, "background", "code-plane"),
    codeBg,
    `the DaisyUI code plane's background must be --code-bg (${codeBg})`,
  );
  assert.equal(
    declaration(plane, "border", "code-plane"),
    `${hairline} solid ${strong}`,
    `the DaisyUI code plane's border must be --stroke-hair solid --strong (${hairline} solid ${strong})`,
  );
  assert.equal(
    declaration(plane, "border-radius", "code-plane"),
    await token("radius-inner"),
    `the DaisyUI code plane's radius must be --radius-inner (${await token("radius-inner")})`,
  );
  assert.equal(
    declaration(plane, "color", "code-plane"),
    await token("syn-plain"),
    `the DaisyUI code plane's ink must be --syn-plain (${await token("syn-plain")}), the same ink the ` +
      `Shiki theme paints unhighlighted code with`,
  );

  // And the net under all of it: no hex in the block that is not a token value
  // this test pins. A value swapped between two pinned properties is caught by
  // the assertions above; a value from outside the system is caught here.
  const pinned = new Set();
  for (const name of [
    ...DAISYUI_PROPERTY_PINS.map(([, tokenName]) => tokenName),
    "canvas",
    "ink-1",
    "code-bg",
    "strong",
    "syn-plain",
  ]) {
    pinned.add((await token(name)).toLowerCase());
  }
  for (const hex of hexesIn(themeCss)) {
    assert.ok(
      pinned.has(hex),
      `the DaisyUI theme block carries ${hex}, which no test pins to a token in luxe-tokens.css. ` +
        `Every restated value must be asserted equal to the token it copies, or it is free to drift.`,
    );
  }
});

// ---- The terminal mockup ----------------------------------------------------

// Two halves of one bug, both caused by the code-plane rule taking `.mockup-code` on
// without finishing the job.
//
// Half one: the rule paints the plane light and says nothing about the text, so DaisyUI's
// `.mockup-code` kept its foreground at `--color-neutral-content` - which this theme maps
// to the near-white paper tone - and the block rendered at roughly 1.06:1. Light ink on a
// light plane, effectively invisible, and true from the day the rule was written: the older
// `--code-bg` it used to name was light too, so recessing the plane neither caused this nor
// fixed it.
//
// Half two: `.mockup-code` is a container with one `<pre>` per terminal line, and every one
// of those lines is matched by the `pre:not(.mermaid)` half of the same selector. Each line
// came out as its own bordered, rounded, padded plate instead of the block reading as one
// terminal.
test("the terminal mockup is one legible plane, not a stack of plates", async () => {
  const plane = ruleBody(
    (rule) => /\bpre\b/.test(rule.selector) && /background\s*:/.test(rule.body),
    "code-plane rule",
  );
  const ink = await token("syn-plain");
  const codeBg = await token("code-bg");

  // Half one: the plane names its own ink, and that ink is readable on it.
  assert.equal(declaration(plane, "color", "code-plane"), ink);
  const ratio = wcagContrast(ink, codeBg);
  assert.ok(
    ratio >= TEXT_FLOOR,
    `the code plane's ink (${ink}) is ${ratio.toFixed(2)}:1 on --code-bg (${codeBg}), floor is ${TEXT_FLOOR}:1`,
  );

  // Half two: the per-line <pre> inside a .mockup-code is not a code plane of its own.
  const rules = themeRules();
  const planeIndex = rules.findIndex((rule) => /\bpre\b/.test(rule.selector) && /background\s*:/.test(rule.body));
  const resetIndex = rules.findIndex((rule) => /^\.mockup-code\s+(>\s*)?pre$/.test(rule.selector.trim()));
  assert.ok(
    resetIndex >= 0,
    "no rule neutralises the <pre> elements inside a .mockup-code, so every terminal LINE is painted " +
      "as its own code plane - a stack of bordered plates instead of one block",
  );
  assert.ok(
    resetIndex > planeIndex,
    "the .mockup-code inner-line reset must come after the code-plane rule: the two selectors weigh the " +
      "same (one class, one element each), so source order is what decides which one wins",
  );

  const reset = rules[resetIndex].body;
  // Everything the plane rule imposes on a line has to be taken back off, or the line keeps
  // whichever piece was forgotten - a stray border, a stray radius, a doubled inset.
  const neutralised = /** @type {[string, RegExp][]} */ ([
    ["background", /^(none|transparent|0 0)$/],
    ["border", /^0$/],
    ["border-radius", /^0$/],
    ["padding", /^0$/],
  ]);
  for (const [property, neutral] of neutralised) {
    assert.match(
      declaration(reset, property, ".mockup-code inner line"),
      neutral,
      `the .mockup-code inner-line reset leaves \`${property}\` from the code-plane rule in place, so each ` +
        `terminal line still draws part of a plate`,
    );
  }
  // And it must not reintroduce an ink of its own: the line inherits the plane's.
  assert.doesNotMatch(reset, /(^|[;\s])color\s*:/, "the inner-line reset should inherit the plane's ink, not set one");
});

// ---- The 4.5:1 floor, on every surface the inks render on -------------------

// `--code-bg` is the code plane; the three diff tints are the surfaces the same
// inks are painted on inside a diff. Shiki maps two of them itself
// (`diffEditor.insertedTextBackground`, `diffEditor.removedTextBackground`) and
// paints the hunk header's text from `meta.diff.range` over a band the renderer
// draws in `--diff-hunk-bg`. None of the three is derived from `--code-bg`, so
// enforcing the floor on the code plane alone left three surfaces free to move.
const INK_SURFACE_TOKENS = ["code-bg", "diff-add-bg", "diff-rem-bg", "diff-hunk-bg"];

// The one carve-out, by name. Punctuation is decoration-grade: it may never be
// the only thing distinguishing two constructs, so it is allowed below the text
// floor. Every other `--syn-*` token is swept, including any added later - a
// hand-written list is how a new ink slips past the guarantee.
const PUNCTUATION_TOKEN = "syn-punct";
const TEXT_FLOOR = 4.5;
const DECORATION_FLOOR = 3;

test("every syntax ink clears 4.5:1 on every surface it renders on", async () => {
  const inks = (await tokensWithPrefix("syn-")).filter((entry) => entry.name !== PUNCTUATION_TOKEN);
  assert.ok(inks.length >= 7, `expected the syntax palette to be swept, found only ${inks.length} inks`);

  for (const surfaceName of INK_SURFACE_TOKENS) {
    const surface = await token(surfaceName);
    for (const ink of inks) {
      const ratio = wcagContrast(ink.value, surface);
      assert.ok(
        ratio >= TEXT_FLOOR,
        `--${ink.name} (${ink.value}) is ${ratio.toFixed(2)}:1 on --${surfaceName} (${surface}), floor is ${TEXT_FLOOR}:1`,
      );
    }
  }
});

// The palette's side of the guarantee is above; this is the theme's. It sweeps
// what Shiki will actually paint, so a scope added to the theme later is
// measured on all four surfaces whether or not anyone names it. `markup.deleted`
// and `markup.inserted` are the reason this matters on the diff tints
// specifically: they are the status inks, not syntax inks, and they land on the
// removed and added planes by definition.
test("every Shiki scope clears 4.5:1 on every surface it renders on", async () => {
  const punct = await token(PUNCTUATION_TOKEN);

  for (const surfaceName of INK_SURFACE_TOKENS) {
    const surface = await token(surfaceName);
    for (const entry of LUXE_SHIKI_THEME.tokenColors) {
      const ink = entry.settings.foreground;
      if (ink === punct) continue;
      const ratio = wcagContrast(ink, surface);
      assert.ok(
        ratio >= TEXT_FLOOR,
        `scope ${entry.scope[0]} (${ink}) is ${ratio.toFixed(2)}:1 on --${surfaceName} (${surface}), floor is ${TEXT_FLOOR}:1`,
      );
    }
  }
});

// The carve-out is a carve-out, not a gap: named, bounded on both sides, and on
// every surface rather than only the one it was originally measured on. If it
// ever clears the text floor everywhere the exception is obsolete and should be
// deleted rather than kept as a standing excuse.
test("punctuation is the one documented exception, on every surface", async () => {
  const punct = await token(PUNCTUATION_TOKEN);
  const ratios = [];

  for (const surfaceName of INK_SURFACE_TOKENS) {
    const surface = await token(surfaceName);
    const ratio = wcagContrast(punct, surface);
    ratios.push(ratio);
    assert.ok(
      ratio >= DECORATION_FLOOR,
      `--${PUNCTUATION_TOKEN} (${punct}) is ${ratio.toFixed(2)}:1 on --${surfaceName} (${surface}), ` +
        `floor is ${DECORATION_FLOOR}:1 - below this it has stopped being legible at all`,
    );
  }

  assert.ok(
    ratios.some((ratio) => ratio < TEXT_FLOOR),
    `--${PUNCTUATION_TOKEN} (${punct}) now clears ${TEXT_FLOOR}:1 on every surface; drop the exception`,
  );

  // And the exception is stated where a reader of the token file meets it.
  const { luxeTokensCss } = await import("./helpers/design-tokens.js");
  assert.match(await luxeTokensCss(), /--syn-punct is the single\s+\*?\s*deliberate exception/);
});
