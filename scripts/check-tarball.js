// Tarball contents gate (issue #30). scripts/build.js and package.json "files" are two
// hand-kept lists; when they drift, the published package silently misses assets - like
// artifact-baseline.css, whose absence 500'd /sdk.js for every npm/npx install of 0.3.x.
// This gate fails the build when any file the runtime resolves is not in the pack list.
//
// Usage: node scripts/check-tarball.js [--tarball <path-to-existing-.tgz>]
// Default: asks npm what WOULD be packed (`npm pack --dry-run --json --ignore-scripts`;
// --ignore-scripts because `npm run check` already built - prepack would rebuild).
// --tarball exists so a published tarball can be audited directly as a negative control.

import { execFileSync } from "node:child_process";

const tarballArg = process.argv.indexOf("--tarball") >= 0 ? process.argv[process.argv.indexOf("--tarball") + 1] : null;

let entries;
if (tarballArg) {
  entries = execFileSync("tar", ["-tzf", tarballArg], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().replace(/^package\//, ""))
    .filter(Boolean);
} else {
  // execFile("npm") is ENOENT on Windows (npm is npm.cmd, and .cmd shims need a shell).
  // Inside `npm run check` the reliable handle is npm_execpath - the npm CLI's own JS
  // entry, run with the current node. The bare-npm fallback covers direct invocation.
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const output = process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: "utf8" })
    : execFileSync("npm", args, { encoding: "utf8", shell: process.platform === "win32" });
  const parsed = JSON.parse(output);
  entries = parsed[0].files.map((file) => file.path);
}

const has = (entry) => entries.includes(entry);
const hasMatch = (pattern) => entries.some((entry) => pattern.test(entry));

// Every file the dist bundle resolves at runtime (audit: grep import.meta.url src/),
// plus the package essentials. Exact names wherever they are stable.
const required = [
  "dist/cli.mjs",
  "dist/chrome-client.js",
  "dist/chrome.css",
  "dist/luxe-tokens.css",
  "dist/artifact-baseline.css",
  "dist/design/daisyui.css",
  "dist/design/daisyui-themes.css",
  "dist/design/tailwindcss-browser.js",
  "dist/fonts/inter-latin-400-normal.woff2",
  "dist/fonts/inter-latin-500-normal.woff2",
  "dist/fonts/jetbrains-mono-latin-400-normal.woff2",
  "dist/fonts/jetbrains-mono-latin-500-normal.woff2",
  "dist/fonts/newsreader-latin-500-normal.woff2",
  "dist/fonts/OFL-Inter.txt",
  "dist/fonts/OFL-JetBrainsMono.txt",
  "dist/fonts/OFL-Newsreader.txt",
  "dist/design/LICENSE-pierre-diffs-Apache-2.0.md",
  "dist/whiteboard/whiteboard.js",
  "dist/whiteboard/whiteboard.css",
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "skills/luxe/SKILL.md",
];
/** @type {Array<[RegExp, string]>} */
const requiredPatterns = [
  [/^dist\/design\/luxe-pierre-diffs-.+\.iife\.js$/, "dist/design/luxe-pierre-diffs-<version>.iife.js"],
  [/^dist\/whiteboard\/fonts\/[^/]+\/[^/]+\.woff2$/, "dist/whiteboard/fonts/<family>/<file>.woff2"],
];

const missing = required.filter((entry) => !has(entry));
for (const [pattern, label] of requiredPatterns) {
  if (!hasMatch(pattern)) missing.push(label);
}

if (missing.length > 0) {
  console.error(`tarball gate FAILED - missing ${missing.length} required entries:`);
  for (const entry of missing) console.error(`  - ${entry}`);
  console.error("scripts/build.js and package.json files have drifted from what the runtime resolves.");
  process.exit(1);
}
console.log(
  `tarball gate passed (${entries.length} entries, ${required.length + requiredPatterns.length} required present)`,
);
