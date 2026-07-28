// The artifact baseline has one job it must never get wrong: repair the artifact without
// restyling it. These tests hold both halves - that the rules reach all three channels
// from one source, and that an artifact with its own opinions still wins.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactDeclinesBaseline,
  BASELINE_STYLE_ID,
  BASELINE_TOKENS_MARKER,
  baselineStyleTag,
  inlineBaselineTokens,
  readArtifactBaselineCss,
} from "../src/artifact-baseline.js";
import { createDesignOutput } from "../src/design-reference.js";
import { createSdkJs, readLuxeTokensCss, serve } from "../src/server.js";
import { wcagContrast } from "./helpers/design-tokens.js";

const sourcePromise = readFile(new URL("../src/artifact-baseline.css", import.meta.url), "utf8");

test("the baseline source carries no colour literals of its own", async () => {
  const source = await sourcePromise;

  assert.ok(source.includes(BASELINE_TOKENS_MARKER), "the token marker is what keeps literals out");
  // src/luxe-tokens.css is the only place in the product a hex may appear. The design
  // adherence lint enforces this too; asserting it here makes the reason local.
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i);
});

test("tokens are namespaced, because this lands in a document Luxe does not own", async () => {
  const css = await readArtifactBaselineCss();

  assert.match(css, /--luxe-bl-scroll-thumb:\s*#[0-9a-f]{6}/i);
  assert.match(css, /--luxe-bl-on-dark-code-bg:\s*rgba\(/);
  // Defining --canvas or --dark-fill on an arbitrary artifact's :root would silently
  // retheme any artifact that happens to use those names for something else.
  assert.doesNotMatch(css, /^\s*--canvas:/m);
  assert.doesNotMatch(css, /^\s*--dark-fill:/m);
  assert.doesNotMatch(css, /^\s*--ink-1:/m);
});

test("a missing token fails the build rather than shipping unthemed", async () => {
  const source = await sourcePromise;
  const tokens = await readLuxeTokensCss();

  assert.throws(() => inlineBaselineTokens(source, ":root{}"), /luxe-tokens\.css does not define/);
  assert.throws(() => inlineBaselineTokens("body{}", tokens), /missing the/);
});

// The layer and the zero specificity are the whole safety argument. If either is lost,
// Luxe starts overriding artifacts instead of repairing them.
test("every rule is inside the layer and carries no specificity", async () => {
  const css = await readArtifactBaselineCss();

  assert.match(css, /@layer luxe-baseline\s*\{/);

  // Brace-match the layer so the ::-webkit- rules that deliberately sit outside it are
  // not swept in, and keep selector matching on one line - `[^{]*` happily spans
  // newlines and starts matching declarations.
  const start = css.indexOf("@layer luxe-baseline");
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const layerBody = css.slice(start, end);
  const selectors = (layerBody.match(/^[^\S\n]*[^@\s{}][^{}\n]*\{\s*$/gm) || []).map((line) => line.trim());
  assert.ok(selectors.length > 3, `expected several rules in the layer, found ${selectors.length}`);
  for (const selector of selectors) {
    assert.match(selector, /:where\(/, `selector without :where() has specificity: ${selector}`);
  }
});

// The repair with the least visible test surface, and the one that already cost us: it
// fixes `test/fixtures/layout-audit/control-broken-overflow.html`'s two-column grid before
// the layout audit ever measures the page, which is how that fixture silently stopped
// exhibiting the defect it was written for. No end-to-end assertion can stand in for this
// one - deleting the rule leaves the audit reporting the same single warning on that
// fixture (its nowrap badge, which no baseline rule can shrink), so the browser suite
// would not notice. This is the only thing that notices.
test("grid and flex children are given min-width:0, the classic overflow trap", async () => {
  const css = await readArtifactBaselineCss();

  assert.match(
    css,
    /:where\(\.grid, \.flex\) > \*,\s*:where\(\[class\*="grid-cols"\], \[class\*="flex-"\]\) > \*\s*\{[^}]*min-width:\s*0/,
    "the baseline no longer gives grid/flex children min-width:0",
  );
});

test("pierre diffs are exempt, because wrapping a split diff destroys its meaning", async () => {
  const css = await readArtifactBaselineCss();
  assert.match(css, /:where\(pre\):not\(:where\(\[data-diffs-container\]/);
});

// One source, three channels. This is the test that makes "single source" true rather
// than a claim in a comment.
test("the runtime, authoring and export channels carry identical rules", async () => {
  const css = await readArtifactBaselineCss();
  const sdk = createSdkJs("abc", await readLuxeTokensCss(), css);
  const design = createDesignOutput({ artifactBaselineSnippet: baselineStyleTag(css) });

  // The SDK embeds it as a JS string literal; JSON.parse of that literal is the CSS back.
  assert.ok(sdk.includes(JSON.stringify(css)), "the SDK carries the baseline verbatim");
  assert.ok(design.artifact_baseline.snippet.includes(css.trim()), "luxe design prints the same rules");
  assert.match(design.artifact_baseline.snippet, new RegExp(`id="${BASELINE_STYLE_ID}"`));
  assert.match(design.artifact_baseline.note, /Repairs, not styling/);
});

test("the SDK inserts the baseline first in head, not appended", async () => {
  const sdk = createSdkJs("abc", await readLuxeTokensCss(), await readArtifactBaselineCss());

  // Appending would make luxe-baseline the LAST declared layer and therefore the
  // highest-priority one - the exact opposite of the intent - because the SDK script
  // runs after every artifact stylesheet has been parsed.
  //
  // Scoped to this function: the annotation cursor style is a different injection with
  // different rules, and it appends quite correctly.
  const body = sdk.slice(sdk.indexOf("function injectArtifactBaseline"));
  const fn = body.slice(0, body.indexOf("\n  }") + 4);
  assert.ok(fn.includes("function injectArtifactBaseline"), "found the injection");
  assert.match(fn, /head\.insertBefore\(style, head\.firstChild\)/);
  assert.doesNotMatch(fn, /appendChild/);
});

test("an artifact can decline the baseline, and is never given two copies", () => {
  assert.equal(artifactDeclinesBaseline("<html><head></head></html>"), false);
  assert.equal(artifactDeclinesBaseline('<html data-luxe-baseline="off">'), true);
  assert.equal(artifactDeclinesBaseline("<html data-luxe-baseline=off>"), true);
  // Already pasted the snippet: the SDK and the export both stand down.
  assert.equal(artifactDeclinesBaseline(`<head><style id="${BASELINE_STYLE_ID}">x</style></head>`), true);
});

test("the export injects the baseline, which runtime injection cannot reach", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-baseline-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const openSession = async (name, html) => {
      const file = path.join(dir, name);
      await writeFile(file, html);
      const res = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      return (await res.json()).key;
    };

    const plain = await openSession("plain.html", "<!doctype html><html><head></head><body><p>hi</p></body></html>");
    const optedOut = await openSession(
      "opted-out.html",
      '<!doctype html><html data-luxe-baseline="off"><head></head><body><p>hi</p></body></html>',
    );
    const alreadyHasIt = await openSession(
      "already.html",
      `<!doctype html><html><head><style id="${BASELINE_STYLE_ID}">.mine{color:red}</style></head><body></body></html>`,
    );

    const exported = async (key) => await (await fetch(`${base}/api/${key}/export`)).text();

    const plainHtml = await exported(plain);
    assert.match(plainHtml, new RegExp(`id="${BASELINE_STYLE_ID}"`), "the export carries the baseline");
    assert.match(plainHtml, /@layer luxe-baseline/);

    assert.doesNotMatch(await exported(optedOut), /@layer luxe-baseline/, "opting out is honoured by the export");

    const twice = await exported(alreadyHasIt);
    assert.equal(
      twice.match(new RegExp(`id="${BASELINE_STYLE_ID}"`, "g"))?.length,
      1,
      "an artifact that already pasted the snippet gets exactly one copy",
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The on-dark repair used to apply half a pair to DaisyUI's `.kbd`: `.kbd` paints itself a
// light key at class specificity, the zero-specificity repair could not displace that
// background (correctly - this file is built to lose), and the light on-dark ink it does
// apply landed on that light key. Measured at 1.04:1 inside a cocoa panel.
//
// The fix is deliberately NOT a specificity escalation, which would buy legibility by
// breaking the contract at the top of artifact-baseline.css. A foreground competes with
// inheritance, not with `.kbd`, so it needs no weight at all; what it does need is to name
// a background alongside it, so the pair stays self-consistent whether `.kbd`'s own
// background wins or this rule's does. That is what this test holds.
test("the on-dark repair never gives a key a foreground without the background to match", async () => {
  const css = await readArtifactBaselineCss();
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].split("*/").pop().trim(), body: match[2] }))
    .filter((rule) => !rule.selector.startsWith("@"));

  const generic = rules.findIndex((rule) => /:where\(code, kbd, samp\)/.test(rule.selector));
  const key = rules.findIndex((rule) => /kbd\.kbd/.test(rule.selector));
  assert.ok(generic >= 0, "the generic on-dark code/kbd/samp repair is gone");
  assert.ok(key > generic, "the .kbd repair must come after the generic one it corrects, and inside the layer");

  const rule = rules[key];
  // Zero specificity, like everything else here. If this ever needs :where() removed to
  // work, the fix is wrong, not the contract.
  assert.match(rule.selector, /:where\(kbd\.kbd\)/, "the .kbd repair gained specificity, which this file forbids");
  assert.doesNotMatch(css, /!important/, "a repair that needs !important is not a repair");

  // The pair, together. Each reads DaisyUI's own variable first - base-200 and
  // base-content are a contrasting pair by construction in any DaisyUI theme, including a
  // dark one - and falls back to a Luxe token where DaisyUI is not loaded at all.
  assert.match(rule.body, /background:\s*var\(--color-base-200,\s*var\(--luxe-bl-key-bg\)\);/);
  assert.match(rule.body, /color:\s*var\(--color-base-content,\s*var\(--luxe-bl-key-ink\)\);/);

  // Both outcomes are legible. With DaisyUI the key is base-200 under base-content; without
  // it the fallbacks are --surface-1 under --ink-1, and those are the values asserted here.
  const tokens = await readLuxeTokensCss();
  const value = (name) => {
    const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(tokens);
    assert.ok(match, `luxe-tokens.css does not define --${name}`);
    return match[1].trim();
  };
  const ratio = wcagContrast(value("ink-1"), value("surface-1"));
  assert.ok(ratio >= 4.5, `a repaired key reads at ${ratio.toFixed(2)}:1, under the 4.5:1 floor`);

  // The generic rule still owns the bare <kbd> case, where the surface really is the dark
  // fill and a light ink is the right answer.
  assert.match(rules[generic].body, /color:\s*var\(--luxe-bl-on-dark-ink\);/);
});

// CSS cannot ask "is the surface behind me dark?", so the stylesheet alone only repairs
// code and marks inside DaisyUI's semantic surface classes. An artifact that paints its
// own cocoa card left <mark> at the user agent's yellow-on-black - which is the exact case
// that prompted the fix. The SDK measures the surface and tags it so the rule applies.
test("the SDK tags genuinely dark surfaces so the on-dark repair can reach them", async () => {
  const sdk = createSdkJs("abc", await readLuxeTokensCss(), await readArtifactBaselineCss());

  assert.match(sdk, /function tagDarkSurfaces/);
  assert.match(sdk, /querySelectorAll\("mark, code, kbd, samp"\)/);
  assert.match(sdk, /setAttribute\("data-luxe-on-dark", ""\)/);
  // A repair, not a restyle: it only fires where the surface really is dark.
  assert.match(sdk, /0\.2126 \* r \+ 0\.7152 \* g \+ 0\.0722 \* b < 0\.18/);
  // Luxe's own controls and highlighted code blocks are none of its business.
  assert.match(sdk, /el\.closest\("\[data-luxe-ui\]"\) \|\| el\.closest\("pre"\)/);

  // And the stylesheet honours the attribute the SDK sets.
  const css = await readArtifactBaselineCss();
  assert.match(css, /\[data-luxe-on-dark\]/);
});
