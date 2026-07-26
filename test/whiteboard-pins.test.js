import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The Mermaid-to-Excalidraw converter reaches into mermaid's rendered DOM and
// diagram.db internals, and versions past 11.13.0 silently degrade class/ER/
// state diagrams and subgraph flowcharts to non-editable image fallbacks
// (mermaid-to-excalidraw#108). The whiteboard bundle therefore pins mermaid
// EXACTLY - independent of the newer Mermaid CDN version artifacts use for
// rendering. If a bump is attempted, this test forces a deliberate re-probe of
// native conversion before it lands.
// The temporary security decision and its exact advisories live in
// docs/security/mermaid-11.12-risk-acceptance.md.

const REQUIRED_EXACT_PINS = {
  mermaid: "11.12.1",
  "@excalidraw/excalidraw": "0.18.1",
  "@excalidraw/mermaid-to-excalidraw": "2.2.2",
};

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

test("whiteboard dependencies are pinned exactly in package.json", () => {
  const pkg = readJson("../package.json");
  for (const [name, version] of Object.entries(REQUIRED_EXACT_PINS)) {
    assert.equal(pkg.devDependencies[name], version, `${name} must be pinned exactly to ${version}`);
  }
});

test("the installed mermaid the whiteboard bundles is the pinned version", () => {
  const installed = readJson("../node_modules/mermaid/package.json");
  assert.equal(installed.version, REQUIRED_EXACT_PINS.mermaid);
});

// The converter call site drives Excalidraw's synchronous text measurement, so
// the theme block and the metrics version are one contract. Bumping the block
// without bumping the version leaves every saved scene measured for glyphs that
// are no longer used, and the labels clip.
test("the shared Mermaid theme and the text-metrics version move together", async () => {
  const { LUXE_MERMAID_THEME_VARIABLES } = await import("../src/mermaid-theme.js");
  const { WHITEBOARD_TEXT_METRICS_VERSION } = await import("../src/whiteboard-core.js");

  // Version 2 is Inter 14px, the Luxe block. Change either of these two lines
  // only together, and only after re-probing native conversion in a browser.
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.fontFamily, '"Inter", -apple-system, "Segoe UI", sans-serif');
  assert.equal(LUXE_MERMAID_THEME_VARIABLES.fontSize, "14px");
  assert.equal(WHITEBOARD_TEXT_METRICS_VERSION, 2);
});

test("the converter is handed the shared theme object, never a restated copy", () => {
  const frame = readFileSync(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");

  assert.match(frame, /parseMermaidToExcalidraw\(source, \{\s*themeVariables: LUXE_MERMAID_THEME_VARIABLES,\s*\}\)/);
  assert.doesNotMatch(frame, /themeVariables:\s*\{/, "the frame must not inline its own themeVariables literal");
});

test("the converter and editor resolve to their pinned versions", () => {
  assert.equal(
    readJson("../node_modules/@excalidraw/mermaid-to-excalidraw/package.json").version,
    REQUIRED_EXACT_PINS["@excalidraw/mermaid-to-excalidraw"],
  );
  assert.equal(
    readJson("../node_modules/@excalidraw/excalidraw/package.json").version,
    REQUIRED_EXACT_PINS["@excalidraw/excalidraw"],
  );
});

test("the retained Mermaid pin has an explicit advisory-specific risk acceptance", () => {
  const acceptance = readFileSync(
    new URL("../docs/security/mermaid-11.12-risk-acceptance.md", import.meta.url),
    "utf8",
  );
  const bundle = readFileSync(new URL("../dist/whiteboard/whiteboard.js", import.meta.url), "utf8");

  assert.match(acceptance, /mermaid@11\.12\.1/);
  assert.match(acceptance, /@excalidraw\/mermaid-to-excalidraw@2\.2\.2/);
  for (const advisory of [
    "GHSA-87f9-hvmw-gh4p",
    "GHSA-ghcm-xqfw-q4vr",
    "GHSA-xcj9-5m2h-648r",
    "GHSA-6m6c-36f7-fhxh",
    "GHSA-r5fr-rjxr-66jc",
  ]) {
    assert.match(acceptance, new RegExp(advisory));
  }
  assert.match(acceptance, /Attempt 1/);
  assert.match(acceptance, /Attempt 2/);
  assert.doesNotMatch(bundle, /templateSettings|Invalid imports option|lodash\.template|importsKeys/);
});
