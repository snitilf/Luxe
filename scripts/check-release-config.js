// Release config gate: a config `release-as` is a standing pin, not a
// one-shot. It applies on every release-please run, so once the pinned
// version has shipped it holds every future release at that version. For a
// one-time version override, use a `Release-As: x.y.z` commit footer instead,
// which release-please consumes exactly once and which leaves nothing behind
// in the tree. This gate fails when a config pin is strictly behind the
// released version - definitely stale. A pin equal to the manifest is allowed
// because the release PR and its tag legitimately carry that state, and this
// gate runs inside their CI.
// Also checks that package.json and the manifest agree on the current version,
// since release-please keeps them in sync and any drift means a release will
// publish a version nobody expects.
// Run via `npm run release-config`; wired into `npm run check`.
import { readFileSync } from "node:fs";

const CONFIG_PATH = "release-please-config.json";
const MANIFEST_PATH = ".release-please-manifest.json";

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const failures = [];

// Returns -1, 0, or 1 comparing two x.y.z strings, or null if either is not a
// plain numeric triple (prereleases and other shapes fall back to equality).
function compareVersions(a, b) {
  const parse = (v) => {
    const parts = String(v).split(".");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : null));
    return nums.every((n) => n !== null) ? nums : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

for (const [path, entry] of Object.entries(config.packages ?? {})) {
  const pin = entry["release-as"];
  if (pin === undefined) continue;

  const released = manifest[path];
  if (released === undefined) continue; // not bootstrapped yet, pin is still doing its job

  const order = compareVersions(pin, released);
  const stale = order !== null && order < 0;

  if (stale) {
    failures.push(
      `${CONFIG_PATH}: packages["${path}"]["release-as"] is "${pin}", but ${MANIFEST_PATH} already ` +
        `reports "${released}" as released. The pin is stale and will hold every future release at ` +
        `"${pin}". Delete the "release-as" line; for a one-time version override use a ` +
        `"Release-As: x.y.z" commit footer instead.`,
    );
  }
}

const rootVersion = manifest["."];
if (rootVersion !== undefined && pkg.version !== rootVersion) {
  failures.push(
    `package.json version "${pkg.version}" does not match ${MANIFEST_PATH} "." version "${rootVersion}". ` +
      `release-please keeps these in sync; drift means the next release publishes an unexpected version.`,
  );
}

if (failures.length > 0) {
  console.error("Release config gate failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("Release config gate passed.");
