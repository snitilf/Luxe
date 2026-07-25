// Smoke test for the built CLI bundle. `npm run check` builds before testing,
// so dist/cli.mjs exists when this runs. Replaced with real coverage as the
// engine lands in Phase 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("dist/cli.mjs --version prints the package version", () => {
  const res = spawnSync(process.execPath, ["./dist/cli.mjs", "--version"], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.equal(res.status, 0);
  assert.equal((res.stdout || "").trim(), pkg.version);
});

test("dist/cli.mjs --help mentions Luxe", () => {
  const res = spawnSync(process.execPath, ["./dist/cli.mjs", "--help"], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Luxe/);
});
