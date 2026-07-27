// Gates for the Luxe design system: one token source, four font sizes, two
// weights, light only, and a font pipeline that actually ships.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.LUXE_HOST = "127.0.0.1";
process.env.LUXE_LINK_HOST = "127.0.0.1";

import { inlineLuxeTokens, LUXE_TOKENS_MARKER } from "../src/chrome-css.js";
import { MARK_PAPER, MARK_COCOA } from "../src/luxe-brand.js";
import { createSdkJs, readLuxeTokensCss, serve } from "../src/server.js";

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const repoUrl = (relative) => new URL(`../${relative}`, import.meta.url);
const read = (relative) => readFile(repoUrl(relative), "utf8");

async function tokenValue(name) {
  const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(await read("src/luxe-tokens.css"));
  return match ? match[1].trim() : null;
}

test("hex literals live only in the token file", async () => {
  for (const file of ["src/chrome.css", "src/artifact-sdk.js", "src/chrome-client.js", "src/server.js"]) {
    const hits = (await read(file)).match(HEX) || [];
    assert.deepEqual(hits, [], `${file} must reference var(--...) instead of hex literals`);
  }
});

// The one exception, declared and pinned: a favicon is an SVG data URI in a
// <link>, so it can neither read a custom property nor be served through CSS.
test("the favicon mark mirrors the tokens exactly", async () => {
  // The mark inverted: an ivory field with a cocoa keyline and letterform, matching the
  // Newsreader wordmark beside it in the toolbar.
  assert.equal(MARK_PAPER, await tokenValue("canvas"));
  assert.equal(MARK_PAPER, await tokenValue("dark-fill-text"));
  assert.equal(MARK_COCOA, await tokenValue("dark-fill"));
});

test("chrome CSS uses only the allowed font sizes and two weights", async () => {
  const css = await read("src/chrome.css");
  // Four content sizes, plus the brand size - which is legal on the wordmark and nowhere
  // else. The scope is a rule the token file states and review enforces; a regex over
  // declarations can only check that the value comes from the scale at all.
  const allowedSizeTokens = new Set([
    "var(--text-heading)",
    "var(--text-body)",
    "var(--text-control)",
    "var(--text-label)",
    "var(--text-brand)",
    "inherit",
  ]);
  for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g)) {
    assert.ok(allowedSizeTokens.has(value.trim()), `unexpected font-size "${value.trim()}" in chrome.css`);
  }
  // @font-face descriptors name the real weight of the file; the rule applies
  // to the styles, not to the face declarations.
  const rules = css.replace(/@font-face\s*\{[^}]*\}/g, "");
  for (const [, value] of rules.matchAll(/font-weight:\s*([^;]+);/g)) {
    assert.ok(
      ["var(--weight-regular)", "var(--weight-medium)", "inherit"].includes(value.trim()),
      `unexpected font-weight "${value.trim()}" in chrome.css`,
    );
  }
  assert.equal(await tokenValue("text-heading"), "28px");
  assert.equal(await tokenValue("text-body"), "16px");
  assert.equal(await tokenValue("text-control"), "15px");
  assert.equal(await tokenValue("text-label"), "14px");
  assert.equal(await tokenValue("weight-regular"), "400");
  assert.equal(await tokenValue("weight-medium"), "500");
});

test("no serif token, no dark mode, no publish dialog, no font CDN", async () => {
  const files = ["src/chrome.css", "src/luxe-tokens.css", "src/artifact-sdk.js", "src/chrome-client.js"];
  for (const file of files) {
    const text = await read(file);
    assert.doesNotMatch(text, /--font-serif/, `${file} declares a serif token`);
    assert.doesNotMatch(text, /prefers-color-scheme/, `${file} branches on the OS theme`);
    assert.doesNotMatch(text, /color-scheme:\s*dark/, `${file} opts into dark rendering`);
    assert.doesNotMatch(text, /\.share-/, `${file} still carries publish-dialog CSS`);
    assert.doesNotMatch(text, /fonts\.(googleapis|gstatic)\.com/, `${file} loads fonts from a CDN`);
  }
});

test("the built stylesheet carries the tokens inline, not an import", async () => {
  const source = await read("src/chrome.css");
  assert.ok(source.includes(LUXE_TOKENS_MARKER), "src/chrome.css must keep the token marker");
  assert.doesNotMatch(source, /@import/, "chrome.css must not @import the tokens - there is no route for them");

  // `npm run check` runs the build first, so dist/chrome.css is current here.
  const built = await read("dist/chrome.css");
  assert.doesNotMatch(built, /@luxe-tokens/, "the build must consume the marker");
  assert.match(built, /--canvas:\s*#f7f4ee/, "dist/chrome.css is missing the design tokens");
  assert.match(built, /--gold:\s*#c77f06/);
  assert.match(built, /--radius-bubble-speaker:\s*6px/);
  assert.equal(built, inlineLuxeTokens(source, await read("src/luxe-tokens.css")));
});

test("the SDK is served with the token block inlined", async () => {
  const js = createSdkJs("abc", await readLuxeTokensCss());

  assert.match(js, /--gold:#c77f06|--gold: ?#c77f06/);
  assert.match(js, /--dark-fill: ?#463527/);
});

// The published bundle has no luxe-tokens.css, so readLuxeTokensCss() falls back
// to regex-extracting the first :root block out of dist/chrome.css. That branch
// is unreachable from a source run, and everything the artifact SDK's shadow DOM
// paints with comes through it - if a future build step minified chrome.css the
// extraction would quietly return "" and every colour in the artifact frame would
// vanish with no error anywhere. This reconstructs the packaged layout (src tree,
// no token file, the built stylesheet in its place) and exercises it for real.
test("the packaged token read recovers the tokens from dist/chrome.css", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-packaged-"));
  try {
    await cp(fileURLToPath(repoUrl("src")), dir, { recursive: true });
    await rm(path.join(dir, "luxe-tokens.css"));
    await cp(fileURLToPath(repoUrl("dist/chrome.css")), path.join(dir, "chrome.css"));
    // Bare imports (express, chokidar) resolve through the parent chain, which
    // stops at the temp dir; lend it the repo's modules.
    await symlink(fileURLToPath(repoUrl("node_modules")), path.join(dir, "node_modules"), "dir");

    const packaged = await import(pathToFileURL(path.join(dir, "server.js")).href);
    const tokens = await packaged.readLuxeTokensCss();

    assert.match(tokens, /^:root\s*\{/, "the packaged branch extracted no :root block from dist/chrome.css");
    assert.match(tokens, /--gold:\s*#c77f06/);
    assert.match(tokens, /--dark-fill:\s*#463527/);
    assert.match(tokens, /--canvas:\s*#f7f4ee/);
    assert.match(tokens, /--focus-ring:\s*#3c5f8f/);
    // The whole block, not a truncated prefix: the SDK re-scopes this text to
    // :host, so a partial extraction would drop tokens silently. chrome.css has
    // a :root of its own further down, which must not be swept in either.
    const sourceBlock = /:root\s*\{[\s\S]*?\n\}/.exec(await read("src/luxe-tokens.css"));
    assert.equal(tokens, sourceBlock[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chrome CSS declares the four bundled faces and nothing else", async () => {
  const css = await read("src/chrome.css");
  const families = [...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*"([^"]+)"[^}]*font-weight:\s*(\d+)/g)].map(
    ([, family, weight]) => `${family} ${weight}`,
  );

  // Newsreader ships one weight: the wordmark is four characters at a single size.
  assert.deepEqual(families, ["Inter 400", "Inter 500", "Newsreader 500", "JetBrains Mono 400", "JetBrains Mono 500"]);
  assert.match(css, /url\("\/fonts\/inter-latin-400-normal\.woff2"\) format\("woff2"\)/);
});

test("fonts are served with the woff2 MIME type and a CORS header", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "luxe-fonts-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json") });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/fonts/inter-latin-400-normal.woff2`);
    const body = await res.arrayBuffer();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    // The whiteboard frame is an opaque origin, and font fetches from an opaque
    // origin are CORS-gated.
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.ok(res.headers.get("cache-control"));
    assert.ok(body.byteLength > 1000);
    // wOF2 magic number.
    assert.equal(Buffer.from(body.slice(0, 4)).toString("latin1"), "wOF2");

    const licence = await fetch(`http://127.0.0.1:${server.port}/fonts/OFL-Inter.txt`);
    assert.equal(licence.status, 200);
    assert.match(await licence.text(), /SIL OPEN FONT LICENSE/i);

    const traversal = await fetch(`http://127.0.0.1:${server.port}/fonts/..%2Fchrome.css`);
    assert.ok(traversal.status === 403 || traversal.status === 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the packed tarball contains the fonts and their licences", () => {
  // --ignore-scripts: the build already ran (npm run check), and prepack would
  // rebuild the whole whiteboard bundle for a file listing.
  const output = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);

  for (const name of [
    "dist/fonts/inter-latin-400-normal.woff2",
    "dist/fonts/inter-latin-500-normal.woff2",
    "dist/fonts/jetbrains-mono-latin-400-normal.woff2",
    "dist/fonts/jetbrains-mono-latin-500-normal.woff2",
    "dist/fonts/OFL-Inter.txt",
    "dist/fonts/OFL-JetBrainsMono.txt",
    "dist/design/luxe-pierre-diffs-1.2.10.iife.js",
    "dist/design/LICENSE-pierre-diffs-Apache-2.0.md",
    "dist/chrome.css",
  ]) {
    assert.ok(files.includes(name), `${name} is missing from npm pack`);
  }
});

test("third-party notices describe the fonts that actually ship", async () => {
  const notices = await read("THIRD-PARTY-NOTICES.md");

  assert.match(notices, /inter-latin-400-normal\.woff2/);
  assert.match(notices, /jetbrains-mono-latin-500-normal\.woff2/);
  assert.match(notices, /OFL-Inter\.txt/);
  assert.match(notices, /OFL-JetBrainsMono\.txt/);
  assert.match(notices, /@pierre\/diffs/);
  assert.match(notices, /LICENSE-pierre-diffs-Apache-2\.0\.md/);
});
