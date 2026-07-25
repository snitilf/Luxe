import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expected = pkg.version;

const res = spawnSync(process.execPath, ["./bin/luxe.js", "--version"], { encoding: "utf8" });
if (res.error) {
  console.error(res.error);
  process.exit(2);
}
const out = (res.stdout || "").trim();
if (out !== expected) {
  console.error(`Expected version '${expected}', got '${out}'`);
  console.error("STDERR:", res.stderr);
  process.exit(1);
}
console.log("CLI smoke test passed");
