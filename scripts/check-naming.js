// Naming gate: upstream product and author identifiers must not appear
// anywhere in this repository, in any tracked file, outside the explicit
// carve-outs below. Run via `npm run naming`; wired into `npm run check`.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";

// Kept as fragments so this gate file does not itself trip a plain-text scan.
const BANNED = [
  ["lav", "ish"].join(""),
  ["kun", "chen"].join(""),
  ["kun", " chen"].join(""),
  ["ht-ml", ".app"].join(""),
];

// Files where an upstream identifier legitimately survives, because the MIT licence
// requires the copyright notice to be retained. Exactly these.
const CARVE_OUTS = new Set(["LICENSE", "THIRD-PARTY-NOTICES.md"]);

const BINARY_EXTENSIONS = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico|zip|gz|tgz)$/i;

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

// dist/ is gitignored so git ls-files never sees it, but it is exactly what
// ships; scan it too when present (e.g. after `npm run build`).
if (existsSync("dist")) {
  for (const entry of readdirSync("dist", { recursive: true })) {
    const path = `dist/${entry}`;
    if (statSync(path).isFile()) files.push(path);
  }
}

const hits = [];
for (const file of files) {
  if (CARVE_OUTS.has(file) || BINARY_EXTENSIONS.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const token of BANNED) {
      if (lower.includes(token)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

if (hits.length > 0) {
  console.error("Naming gate failed. Upstream identifiers found outside carve-outs:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`Naming gate passed (${files.length} files scanned).`);
