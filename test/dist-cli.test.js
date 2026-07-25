// The published package ships only dist/cli.mjs (the bin entry); every other
// test spawns bin/luxe.js source. This is the one test that executes the
// actual bundle. `npm run check` builds before testing, so dist/ exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("dist/cli.mjs --version prints the package version", () => {
  const res = spawnSync(process.execPath, ["./dist/cli.mjs", "--version"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(res.status, 0);
  assert.equal((res.stdout || "").trim(), pkg.version);
});

test("dist/cli.mjs --help prints Luxe guidance", () => {
  const res = spawnSync(process.execPath, ["./dist/cli.mjs", "--help"], { encoding: "utf8", cwd: repoRoot });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Luxe/i);
});
