#!/usr/bin/env node
// Runs the real-browser test files with their gate switched on, one at a time, and fails
// unless they actually ran.
//
// The gate exists because these tests drive a real Chrome and take minutes, so they stay
// out of `npm run check`. Setting it inline (`LUXE_BROWSER_E2E=1 node --test`) is not
// portable to Windows cmd, and the file list is discovered rather than hardcoded so a new
// gated suite cannot be added and then silently never run - the failure mode this script
// exists to end.
//
// Discovery alone does not end it, though: launching a suite is not the same as running
// it. Rename the gate, compare it against a different value, or read it through a helper,
// and every discovered suite reports SKIP while this script exits 0 - green CI, zero
// browser coverage. So each suite is run in its own process and its result counts are
// read back; a suite that reported skipped, or reported nothing at all, is a failure here.
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATE = "LUXE_BROWSER_E2E";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "test");

// `\b` so a suite reading a *different* variable that merely starts with the gate name
// (LUXE_BROWSER_E2E_DEBUG) is not mistaken for a gated suite.
const gateReference = new RegExp(`process\\.env\\.${GATE}\\b`);

const entries = await readdir(testDir);
const gated = [];
for (const entry of entries.sort()) {
  if (!entry.endsWith(".test.js")) continue;
  const source = await readFile(path.join(testDir, entry), "utf8");
  if (gateReference.test(source)) gated.push(path.join("test", entry));
}

if (gated.length === 0) {
  console.error(`No test file reads process.env.${GATE}. Nothing to run - did the gate get renamed?`);
  process.exit(1);
}

// These suites drive Chrome through the `chrome-devtools-axi` CLI. It is a devDependency,
// so npm puts it on PATH for this script - but a tree that was never installed would
// otherwise surface as an ENOENT deep inside an assertion instead of as an instruction.
// `shell` on Windows because a node_modules/.bin entry resolves through a .cmd shim
// there, which spawnSync cannot find on its own - without it the probe reports ENOENT for
// an install that is actually present.
const probe = spawnSync("chrome-devtools-axi", ["--help"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (probe.error && /** @type {NodeJS.ErrnoException} */ (probe.error).code === "ENOENT") {
  console.error("chrome-devtools-axi is not on PATH. It is a devDependency - run `npm ci` first.");
  process.exit(1);
}

// chrome-devtools-axi's bridge resolves the process that actually drives Chrome in this
// order: CHROME_DEVTOOLS_AXI_MCP_PATH, then a global chrome-devtools-mcp install, then
// `npx -y chrome-devtools-mcp@latest`. That last fallback fetches an unpinned package
// from the network mid-test and runs it with full rights, so a publish upstream changes
// what CI executes with no diff here. chrome-devtools-mcp is a pinned devDependency now,
// and pointing the env var at it takes both the network and the version drift out of the
// run. The bridge is spawned with `...process.env`, so this reaches it through the test
// process and the CLI.
const mcpPath = path.join(
  repoRoot,
  "node_modules",
  "chrome-devtools-mcp",
  "build",
  "src",
  "bin",
  "chrome-devtools-mcp.js",
);

console.log(`Running ${gated.length} real-browser test file(s) with ${GATE}=1 - this needs a local Chrome.`);
for (const file of gated) console.log(`  ${file}`);

/**
 * Read the counts out of a node:test TAP summary.
 *
 * @param {string} tap
 * @returns {{ pass: number, fail: number, skipped: number }}
 */
function parseTapCounts(tap) {
  /** @param {string} name */
  const count = (name) => {
    const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
    return match ? Number(match[1]) : 0;
  };
  return { pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
}

const reportDir = await mkdtemp(path.join(os.tmpdir(), "luxe-browser-tests-"));
/** @type {{ file: string, reason: string }[]} */
const didNotRun = [];
let exitStatus = 0;

try {
  for (const file of gated) {
    const tapFile = path.join(reportDir, `${path.basename(file)}.tap`);
    // One process per suite: sequential by construction (two Chromes at once on a 2-core
    // runner is contention on the flakiest tests in the repo), and it attributes the
    // counts below to a named file instead of to an anonymous aggregate.
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=tap",
        `--test-reporter-destination=${tapFile}`,
        file,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, [GATE]: "1", CHROME_DEVTOOLS_AXI_MCP_PATH: mcpPath },
        stdio: "inherit",
      },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) exitStatus = result.status ?? 1;

    const { pass, fail, skipped } = parseTapCounts(await readFile(tapFile, "utf8").catch(() => ""));
    if (skipped > 0) {
      didNotRun.push({ file, reason: `${skipped} test(s) reported SKIP` });
    } else if (pass === 0 && fail === 0) {
      didNotRun.push({ file, reason: "no test reported a result" });
    }
  }
} finally {
  await rm(reportDir, { recursive: true, force: true });
}

if (didNotRun.length > 0) {
  console.error("");
  console.error(`These real-browser suites were discovered and launched with ${GATE}=1, but did not run:`);
  for (const { file, reason } of didNotRun) console.error(`  ${file} - ${reason}`);
  console.error("");
  console.error(
    "This is not an infrastructure hiccup: the suites are gated, and the gate did not open. " +
      `Check that each file above still branches on process.env.${GATE} and treats "1" as on - ` +
      "a renamed variable, a different comparison, or a helper that reads it indirectly all " +
      "produce a silent SKIP, which is zero browser coverage reported as success.",
  );
  process.exit(1);
}

process.exit(exitStatus);
