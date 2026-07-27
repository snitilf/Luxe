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
