// The Luxe design adherence lint.
//
//   node scripts/check-design-adherence.js                       # lint the skill itself
//   node scripts/check-design-adherence.js path/to/artifact.html  # lint your own output
//
// Upstream shipped this as an oxlint config whose rules were written against
// JSX and whose font rule named three families by hand. Both premises are gone:
// decision D9 deleted the JSX kit, so the config had no files left to lint, and
// a hardcoded family list rejects the system it is meant to protect the moment
// that system changes. This lint reads `adherence.json`, which is generated
// from `src/luxe-tokens.css`, so the rules move when the tokens move.
//
// What it checks:
//
//   no-literal-color  no colour literal anywhere in the file, in a declaration
//                     or in prose. A swatch is labelled with its token name and
//                     shows its colour by rendering it; a value copied into a
//                     caption or a paragraph is a value that drifts. SVG
//                     artwork is the one exception, because it cannot read a
//                     custom property - there a literal is allowed, but only if
//                     it is a value that exists in the token file.
//   font-family       only the two bundled families
//   font-size         only the four sizes in the scale
//   font-weight       only the two weights in the scale
//   border-radius     only the radii in the geometry scale
//
// The last four are read out of CSS declarations: `<style>` blocks,
// `style="..."` attributes, and `.css` files.
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKILL_URL = new URL("../.agents/skills/luxe-design/", import.meta.url);
const SKILL_DIR = fileURLToPath(SKILL_URL);

/** @type {{ families: Record<string,string>, fontSizes: Record<string,string>, fontWeights: Record<string,string>, radii: Record<string,string>, rules: { id: string, message: string }[], tokens: { name: string, value: string }[] }} */
const manifest = JSON.parse(await readFile(new URL("adherence.json", SKILL_URL), "utf8"));

const rule = (/** @type {string} */ id) => manifest.rules.find((entry) => entry.id === id)?.message ?? id;
const allowedFamilies = new Set(Object.values(manifest.families).map((family) => family.toLowerCase()));
const allowedSizes = new Set(Object.values(manifest.fontSizes));
const allowedWeights = new Set(Object.values(manifest.fontWeights));
const allowedRadii = new Set(Object.values(manifest.radii));
const tokenValues = new Set(manifest.tokens.map((token) => token.value.toLowerCase()));

// Generic families are not a second type system, they are the fallback chain
// every stack needs, so a declaration may name them beside a bundled face.
const GENERIC_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "inherit",
  "initial",
  "-apple-system",
  "blinkmacsystemfont",
  "sfmono-regular",
  "segoe ui",
  "roboto",
  "menlo",
  "consolas",
  // The brand face's own fallback chain, same role as the sans stack's entries above.
  "georgia",
  "times new roman",
]);

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;

// The full CSS Color Module Level 4 named-colour keyword set (147 names).
// `transparent` and `currentColor` are deliberately absent: they are not
// colour literals in the sense this rule means (they resolve to whatever the
// surrounding context already is), so both stay allowed.
const CSS_NAMED_COLORS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];
const NAMED_COLOR = new RegExp(`\\b(?:${CSS_NAMED_COLORS.join("|")})\\b`, "i");

/**
 * Every CSS declaration in a file, with the line it sits on.
 * @param {string} source
 * @param {string} file
 * @returns {{ property: string, value: string, line: number }[]}
 */
function declarations(source, file) {
  /** @type {{ text: string, offset: number }[]} */
  const blocks = [];
  if (extname(file) === ".css") {
    blocks.push({ text: source, offset: 0 });
  } else {
    for (const match of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      blocks.push({ text: match[1], offset: (match.index ?? 0) + match[0].indexOf(match[1]) });
    }
    // Double- and single-quoted attributes both occur in the wild. Each
    // branch of the alternation is anchored to its own quote character, so a
    // double-quoted value may contain an apostrophe (and a single-quoted one
    // a literal double quote) without either terminating the match early.
    for (const match of source.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const text = match[1] ?? match[2];
      blocks.push({ text, offset: (match.index ?? 0) + match[0].indexOf(text) });
    }
  }

  /** @type {{ property: string, value: string, line: number }[]} */
  const found = [];
  for (const block of blocks) {
    const text = block.text.replaceAll(/\/\*[\s\S]*?\*\//g, " ");
    // Split on every CSS punctuation mark, not just the semicolon: splitting on
    // `;` alone glues a selector onto the first declaration of each rule block,
    // and that declaration then never matches.
    let cursor = 0;
    for (const statement of text.split(/[;{}]/)) {
      const at = block.offset + cursor;
      cursor += statement.length + 1;
      const match = /^\s*([a-z-]+)\s*:\s*([^;{}]+)$/i.exec(statement);
      if (!match) continue;
      found.push({
        property: match[1].toLowerCase(),
        value: match[2].trim(),
        line: source.slice(0, at).split("\n").length,
      });
    }
  }
  return found;
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

const SVG_PRESENTATION_PROPERTIES = ["fill", "stroke", "font-family", "font-size", "font-weight", "rx", "ry"];

/**
 * SVG presentation attributes (`fill="..."`, `font-size="34"`, `rx="7"`, ...)
 * carry the same design meaning as their CSS-declaration equivalents, but
 * live on the tag itself rather than in a `style="..."` attribute or a
 * `<style>` block, so `declarations()` never sees them.
 * @param {string} source
 * @returns {{ property: string, value: string, line: number }[]}
 */
function svgPresentationAttrs(source) {
  const pattern = new RegExp(`\\s(${SVG_PRESENTATION_PROPERTIES.join("|")})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "gi");
  /** @type {{ property: string, value: string, line: number }[]} */
  const found = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[2] ?? match[3];
    found.push({
      property: match[1].toLowerCase(),
      value,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

// SVG attribute values are frequently bare numbers in user units (`font-size="34"`,
// `rx="7"`), where the CSS scale is expressed in `px`. Treat a bare number the
// way the SVG spec does: as that many px, so it can compare against the scale.
const withPxUnit = (/** @type {string} */ value) => (/^-?[\d.]+$/.test(value) ? `${value}px` : value);

// The brand mark's tile corner is drawn at rx="6", which IS on the geometry scale
// (--radius-bubble-speaker). The keyline mark that replaced the old solid tile in July
// 2026 resolved this: the previous artwork used rx="22", which was on no scale and needed
// a narrowly-scoped exemption for exactly that attribute on exactly those two files.
// Nothing needs exempting now, and the map is kept empty rather than deleted so the
// mechanism is still here if a future brand asset genuinely needs one.
const RADIUS_EXEMPTIONS = new Map();

/**
 * @param {string} file
 * @param {string} source
 * @returns {string[]}
 */
export function lintSource(file, source) {
  file = file.replaceAll("\\", "/");
  /** @type {string[]} */
  const problems = [];
  const report = (/** @type {number} */ line, /** @type {string} */ id, /** @type {string} */ detail) =>
    problems.push(`${file}:${line}: ${id} - ${detail}. ${rule(id)}`);

  // Colour literals are scanned over the whole file rather than per
  // declaration, so a value copied into a caption or a paragraph is caught too.
  const isArtwork = extname(file) === ".svg";
  for (const [index, text] of source.split("\n").entries()) {
    for (const literal of text.match(COLOR_LITERAL) ?? []) {
      if (isArtwork && tokenValues.has(literal.toLowerCase())) continue;
      const why = isArtwork ? `${literal} is not a token value` : literal;
      problems.push(`${file}:${index + 1}: no-literal-color - ${why}. ${rule("no-literal-color")}`);
    }
  }

  for (const { property, value, line } of declarations(source, file)) {
    // A custom property is a declaration of the system, not a use of it.
    if (property.startsWith("--")) continue;
    const named = NAMED_COLOR.exec(value.replaceAll(/var\([^)]*\)/g, " "));
    if (named) report(line, "no-literal-color", `${property}: ${named[0]}`);

    if (property === "font-family") {
      for (const family of splitList(value)) {
        if (family.startsWith("var(")) continue;
        if (allowedFamilies.has(family.toLowerCase()) || GENERIC_FAMILIES.has(family.toLowerCase())) continue;
        report(line, "font-family", family);
      }
    }
    if (property === "font-size" && !value.startsWith("var(") && !allowedSizes.has(value)) {
      report(line, "font-size", value);
    }
    if (property === "font-weight" && !value.startsWith("var(") && !allowedWeights.has(value)) {
      report(line, "font-weight", value);
    }
    if (property === "border-radius") {
      for (const corner of value.split(/[\s/]+/)) {
        if (corner.startsWith("var(") || corner === "0" || corner === "50%" || corner === "inherit") continue;
        if (!allowedRadii.has(corner)) report(line, "border-radius", corner);
      }
    }
  }

  // SVG presentation attributes carry the same design meaning as their CSS
  // equivalents, but sit on the tag rather than in `style="..."` or a
  // `<style>` block, so `declarations()` never sees them.
  const exemptRadii = RADIUS_EXEMPTIONS.get(file);
  for (const { property, value, line } of svgPresentationAttrs(source)) {
    if (value.startsWith("var(") || value.startsWith("url(") || value === "none" || value === "inherit") continue;

    if (property === "fill" || property === "stroke") {
      // Hex/rgb/hsl literals are already caught by the whole-file colour scan
      // above (with the SVG token exception applied); only named colours,
      // which that scan does not match, need checking here.
      const named = NAMED_COLOR.exec(value);
      if (named) report(line, "no-literal-color", `${property}: ${named[0]}`);
    }
    if (property === "font-family") {
      for (const family of splitList(value)) {
        if (allowedFamilies.has(family.toLowerCase()) || GENERIC_FAMILIES.has(family.toLowerCase())) continue;
        report(line, "font-family", family);
      }
    }
    if (property === "font-size" && !allowedSizes.has(withPxUnit(value))) {
      report(line, "font-size", value);
    }
    if (property === "font-weight" && !allowedWeights.has(value)) {
      report(line, "font-weight", value);
    }
    if (property === "rx" || property === "ry") {
      if (value === "0" || value === "50%") continue;
      if (exemptRadii?.has(value)) continue;
      if (!allowedRadii.has(withPxUnit(value))) report(line, "border-radius", `${property}: ${value}`);
    }
  }

  return problems;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if ([".html", ".css", ".svg", ".md"].includes(extname(entry.name))) files.push(path);
  }
  return files.sort();
}

const explicit = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
// The generated token file is the one place a literal belongs.
const targets = explicit.length > 0 ? explicit : (await walk(SKILL_DIR)).filter((file) => !file.endsWith("tokens.css"));

/** @type {string[]} */
const problems = [];
for (const target of targets) {
  problems.push(...lintSource(relative(ROOT, target) || target, await readFile(target, "utf8")));
}

if (problems.length > 0) {
  console.error(`Design adherence lint failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Design adherence lint passed (${targets.length} files).`);
