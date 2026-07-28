import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";

import * as esbuild from "esbuild";

import { inlineLuxeTokens } from "../src/chrome-css.js";
import {
  PIERRE_DIFFS_ASSET_FILE,
  PIERRE_DIFFS_GLOBAL,
  PIERRE_DIFFS_MAX_BYTES,
  PIERRE_DIFFS_SHA384,
} from "../src/pierre-diffs-vendor.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/luxe.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LUXE_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

await chmod("dist/cli.mjs", 0o755);
await copyFile("src/chrome-client.js", "dist/chrome-client.js");

// The design tokens are inlined into the shipped stylesheet - see src/chrome-css.js
// for why this is not an @import.
await writeFile(
  "dist/chrome.css",
  inlineLuxeTokens(await readFile("src/chrome.css", "utf8"), await readFile("src/luxe-tokens.css", "utf8")),
);

// Chrome fonts. Pre-published latin subsets from the @fontsource packages, not
// re-subset here: subsetting is a Modified Version under the SIL OFL and drags
// in each family's Reserved Font Name rules. The full licence text for each
// family ships beside the files, which the OFL requires.
await mkdir("dist/fonts", { recursive: true });
const chromeFonts = [
  ["@fontsource/inter", "inter-latin-400-normal.woff2"],
  ["@fontsource/inter", "inter-latin-500-normal.woff2"],
  ["@fontsource/jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2"],
  ["@fontsource/jetbrains-mono", "jetbrains-mono-latin-500-normal.woff2"],
  // One weight only: Newsreader is scoped to the wordmark, which is four characters
  // at a single size and never renders in another weight.
  ["@fontsource/newsreader", "newsreader-latin-500-normal.woff2"],
];
for (const [pkg, file] of chromeFonts) {
  await copyFile(`node_modules/${pkg}/files/${file}`, `dist/fonts/${file}`);
}
await copyFile("node_modules/@fontsource/inter/LICENSE", "dist/fonts/OFL-Inter.txt");
await copyFile("node_modules/@fontsource/jetbrains-mono/LICENSE", "dist/fonts/OFL-JetBrainsMono.txt");
await copyFile("node_modules/@fontsource/newsreader/LICENSE", "dist/fonts/OFL-Newsreader.txt");

await mkdir("dist/design", { recursive: true });
await copyFile("node_modules/daisyui/daisyui.css", "dist/design/daisyui.css");
await copyFile("node_modules/daisyui/themes.css", "dist/design/daisyui-themes.css");
await copyFile("node_modules/@tailwindcss/browser/dist/index.global.js", "dist/design/tailwindcss-browser.js");

// The code-review playbook must never direct an artifact to execute a CDN bundle.
// Build one exact, classic browser asset from the pinned package instead. Classic script
// syntax is intentional: export-bundle can inline it into a single-file export, unlike a
// module graph. The fixed digest makes a changed dependency, esbuild output, or committed
// asset fail the build before it can reach an artifact.
const pierreDiffsAsset = `dist/design/${PIERRE_DIFFS_ASSET_FILE}`;
await esbuild.build({
  entryPoints: ["@pierre/diffs"],
  outfile: pierreDiffsAsset,
  bundle: true,
  minify: true,
  format: "iife",
  globalName: PIERRE_DIFFS_GLOBAL,
  platform: "browser",
  target: "es2022",
});
const pierreDiffsBytes = await readFile(pierreDiffsAsset);
if (pierreDiffsBytes.length > PIERRE_DIFFS_MAX_BYTES) {
  throw new Error(`${PIERRE_DIFFS_ASSET_FILE} exceeds the ${PIERRE_DIFFS_MAX_BYTES}-byte export asset cap`);
}
const pierreDiffsDigest = `sha384-${createHash("sha384").update(pierreDiffsBytes).digest("base64")}`;
if (pierreDiffsDigest !== PIERRE_DIFFS_SHA384) {
  throw new Error(
    `${PIERRE_DIFFS_ASSET_FILE} digest mismatch: expected ${PIERRE_DIFFS_SHA384}, got ${pierreDiffsDigest}`,
  );
}
await copyFile("node_modules/@pierre/diffs/LICENSE.md", "dist/design/LICENSE-pierre-diffs-Apache-2.0.md");

// Whiteboard frame: a self-contained browser bundle (Excalidraw + the Mermaid
// converter + its exactly-pinned mermaid + React) served from
// /whiteboard-assets/ by an embedded frame for every rendered Mermaid diagram
// in a `.mermaid` container.
// Everything is vendored so the eagerly loaded whiteboards work fully offline.
await mkdir("dist/whiteboard", { recursive: true });
await esbuild.build({
  entryPoints: { whiteboard: "src/whiteboard-frame.js" },
  outdir: "dist/whiteboard",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  conditions: ["production"],
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  // The shell stylesheet names the chrome faces by their served URL. They are
  // answered by the server's /fonts route (which sets the CORS header this
  // opaque-origin frame needs), not vendored into the bundle, so esbuild must
  // leave the reference alone rather than try to resolve it on disk.
  external: ["/fonts/*"],
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.IS_PREACT": '"false"',
  },
});

// Excalidraw lazily fetches canvas fonts from `EXCALIDRAW_ASSET_PATH/fonts/`.
// Vendor every family except Xiaolai (12 MB of CJK glyphs; those fall back to
// Excalidraw's CDN fallback or the system font when missing locally).
const fontFamilies = ["Assistant", "Cascadia", "ComicShanns", "Excalifont", "Liberation", "Lilita", "Nunito", "Virgil"];
await mkdir("dist/whiteboard/fonts", { recursive: true });
for (const family of fontFamilies) {
  await cp(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${family}`, `dist/whiteboard/fonts/${family}`, {
    recursive: true,
  });
}
