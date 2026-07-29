import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MERMAID_VERSION } from "../src/design-reference.js";

async function readPackageJson() {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
}

const RELEASE_ACTION_PINS = [
  ["googleapis/release-please-action", "5c625bfb5d1ff62eadeeb3772007f7f66fdcf071", "v4.4.1"],
  ["actions/checkout", "d23441a48e516b6c34aea4fa41551a30e30af803", "v6.1.0"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38", "v6.5.0"],
];

test("check script runs all verification commands", async () => {
  const packageJson = await readPackageJson();
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "npm run build",
    "node scripts/build-skill.js --check",
    "node scripts/build-design-skill.js --check",
    "node scripts/check-design-adherence.js",
    "npm run lint",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "npm run naming",
    "npm run release-config",
  ]);
});

// The browser suites are gated on an env var, so nothing fails when they stop running -
// they just report SKIP forever and read as coverage. `check:browser` is the only thing
// that runs them, so it has to exist, stay out of the local gate (real Chrome, tens of
// seconds), and stay wired into CI.
test("browser tests have their own script, outside check, and run in CI", async () => {
  const packageJson = await readPackageJson();
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.equal(packageJson.scripts["check:browser"], "node scripts/run-browser-tests.js");
  assert.doesNotMatch(packageJson.scripts.check, /check:browser/);
  assert.match(workflow, /run: npm run check:browser/);
});

// The CLI that drives Chrome used to be an undeclared prerequisite, present only because
// of a global install, with CI pinning it by hand. It is a devDependency now, which is
// what puts it on PATH for `check:browser` and locks it in package-lock.json. A range
// would let a CLI release change what CI runs, and a reinstated global step would let the
// declared version drift away from the one actually exercised.
//
// chrome-devtools-axi is only half the chain: its bridge spawns chrome-devtools-mcp,
// which is the process that actually drives Chrome. Left alone it runs
// `npx -y chrome-devtools-mcp@latest` - an unpinned package fetched over the network
// mid-test and executed with full rights in CI. Pinning it as a devDependency only helps
// if the runner points the bridge at that copy, so both halves are asserted here.
const BROWSER_CLI_PACKAGES = ["chrome-devtools-axi", "chrome-devtools-mcp"];

// Two different Mermaids exist here on purpose, and it is worth stating because the obvious
// tidy-up breaks a whiteboard contract. MERMAID_VERSION is what an artifact loads from the
// CDN at render time. The mermaid devDependency is what the whiteboard BUNDLES through
// @excalidraw/mermaid-to-excalidraw, and test/whiteboard-pins.test.js holds it at an exact
// version because Excalidraw measures glyphs synchronously at conversion time: bumping it
// re-measures every scene ever saved, which is why WHITEBOARD_TEXT_METRICS_VERSION exists.
//
// So this asserts that they are ALLOWED to differ, rather than that they match. If a future
// reader "aligns" them, the whiteboard pin test fails and points here.
test("the CDN Mermaid and the bundled Mermaid are tracked separately", async () => {
  const packageJson = await readPackageJson();
  assert.match(
    packageJson.devDependencies.mermaid ?? "",
    /^\d+\.\d+\.\d+$/,
    "the bundled mermaid must be pinned exactly",
  );
  assert.match(MERMAID_VERSION, /^\d+\.\d+\.\d+$/, "the CDN mermaid version must be exact");
});

test("the browser-driving CLIs are pinned devDependencies, not global installs", async () => {
  const packageJson = await readPackageJson();
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  for (const name of BROWSER_CLI_PACKAGES) {
    assert.match(packageJson.devDependencies[name] ?? "", /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  }

  // Matched per line and per part, not as one fixed phrase: `npm i -g`, `npm add -g`,
  // `npm install --global` and a trailing `-g` are the same reinstated global install,
  // and a single literal regex waves all of them through.
  const installsGlobally = /\bnpm\s+(?:install|i|add)\b/;
  const globalFlag = /(?:^|\s)(?:-g|--global)(?:\s|$)/;
  for (const line of workflow.split("\n")) {
    if (!installsGlobally.test(line) || !globalFlag.test(line)) continue;
    for (const name of BROWSER_CLI_PACKAGES) {
      assert.ok(
        !line.includes(name),
        `CI installs ${name} globally, which lets the exercised version drift from the pinned one:\n${line.trim()}`,
      );
    }
  }
});

// The pin above is worth nothing unless the bridge is told to use it: without
// CHROME_DEVTOOLS_AXI_MCP_PATH it falls through to `npx -y chrome-devtools-mcp@latest`.
test("the browser runner points the bridge at the pinned chrome-devtools-mcp", async () => {
  const runner = await readFile(new URL("../scripts/run-browser-tests.js", import.meta.url), "utf8");

  assert.match(runner, /CHROME_DEVTOOLS_AXI_MCP_PATH/);
  assert.match(runner, /node_modules["'\s,]+.*chrome-devtools-mcp/);
});

test("installable skill stays in sync with the no-args home output", async () => {
  const { createSkillMarkdown } = await import("../src/skill.js");
  const committed = await readFile(new URL("../skills/luxe/SKILL.md", import.meta.url), "utf8");

  assert.equal(committed, createSkillMarkdown(), "run `npm run build:skill` and commit the result");
});

test("published package includes the installable skill", async () => {
  const packageJson = await readPackageJson();

  assert.ok(packageJson.files.includes("skills/luxe"));
});

// `files` must exclude src/: shouldForceRestartForLocalBuild() treats a src/server.js
// sitting next to dist/cli.mjs as a local build and restarts the server on every call.
test("published package ships only the bundle, never src", async () => {
  const packageJson = await readPackageJson();

  assert.ok(!packageJson.files.some((entry) => entry === "src" || entry.startsWith("src/")));
  assert.ok(!packageJson.files.some((entry) => entry === "bin" || entry.startsWith("bin/")));
});

// npm runs a single bin regardless of its name, so `npx -y editeur-luxe` works with a
// bin named `luxe`. A second entry breaks that.
test("package exposes exactly one bin, pointing at the built bundle", async () => {
  const packageJson = await readPackageJson();

  assert.deepEqual(packageJson.bin, { luxe: "dist/cli.mjs" });
});

// `.agents/skills/` is a discovery prefix for the skills CLI, so this skill is
// offered to anyone running `npx skills add snitilf/Luxe` unless the frontmatter
// says otherwise. `metadata.internal: true` is the only thing hiding it, and
// dropping it fails nothing at runtime - which is exactly why it needs a test.
test("the internal design skill stays hidden from installers", async () => {
  const skillMd = await readFile(new URL("../.agents/skills/luxe-design/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.match(frontmatter, /^metadata:\n {2}internal: true$/m);
  assert.match(frontmatter, /^name: luxe-design$/m);
});

test("public luxe skill is not marked internal", async () => {
  const skillMd = await readFile(new URL("../skills/luxe/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.doesNotMatch(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("build copies local design assets for published artifact injection", async () => {
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.match(buildScript, /daisyui\.css/);
  assert.match(buildScript, /daisyui-themes\.css/);
  assert.match(buildScript, /tailwindcss-browser\.js/);
});

test("package metadata matches the GitHub repository used for npm provenance", async () => {
  const packageJson = await readPackageJson();

  assert.equal(packageJson.repository.url, "git+https://github.com/snitilf/Luxe.git");
  assert.equal(packageJson.bugs.url, "https://github.com/snitilf/Luxe/issues");
  assert.equal(packageJson.homepage, "https://github.com/snitilf/Luxe#readme");
});

// The build vendors these into the tarball that `npx -y` executes, so a range would let
// the shipped bundle change without any diff.
test("browser-bundled dependencies are pinned exactly", async () => {
  const packageJson = await readPackageJson();
  const pinned = {
    "@tailwindcss/browser": packageJson.dependencies["@tailwindcss/browser"],
    "axi-sdk-js": packageJson.dependencies["axi-sdk-js"],
    "@excalidraw/excalidraw": packageJson.devDependencies["@excalidraw/excalidraw"],
    "@excalidraw/mermaid-to-excalidraw": packageJson.devDependencies["@excalidraw/mermaid-to-excalidraw"],
    "@pierre/diffs": packageJson.devDependencies["@pierre/diffs"],
    mermaid: packageJson.devDependencies.mermaid,
    react: packageJson.devDependencies.react,
    "react-dom": packageJson.devDependencies["react-dom"],
  };

  for (const [name, specifier] of Object.entries(pinned)) {
    assert.match(specifier ?? "", /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got ${specifier}`);
  }
});

test("npm lockfile root importer matches the publish manifest", async () => {
  const packageJson = await readPackageJson();
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const root = lock.packages[""];

  assert.equal(lock.name, packageJson.name);
  assert.deepEqual(root.dependencies, packageJson.dependencies);
  assert.deepEqual(root.devDependencies, packageJson.devDependencies);
});

test("release workflow publishes from the release tag checkout", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");

  assert.match(
    workflow,
    new RegExp(
      `uses: actions/checkout@${RELEASE_ACTION_PINS[1][1]} # ${RELEASE_ACTION_PINS[1][2]}\\n` +
        "\\s+if: \\$\\{\\{ steps\\.release\\.outputs\\.release_created \\}\\}\\n" +
        "\\s+with:\\n" +
        "\\s+ref: \\$\\{\\{ steps\\.release\\.outputs\\.tag_name \\}\\}",
    ),
  );
});

test("release workflow pins every action and the npm CLI immutably", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");
  const usesLines = [...workflow.matchAll(/^\s*-\s+uses:\s+(\S+?)(?:\s+#\s*(\S+))?\s*$/gm)];
  const actionPins = usesLines.map((match) => {
    const at = match[1].lastIndexOf("@");
    return [match[1].slice(0, at), match[1].slice(at + 1), match[2] || ""];
  });

  assert.deepEqual(actionPins, RELEASE_ACTION_PINS);
  assert.ok(actionPins.every(([, ref]) => /^[0-9a-f]{40}$/.test(ref)));
  assert.match(workflow, /^\s*-\s+run: npm install -g npm@11\.18\.0\s*$/m);
  assert.equal([...workflow.matchAll(/\bnpm install -g npm@/g)].length, 1);
});

// Upstream carried an analytics env block into the publish step. It is gone, and the
// build no longer defines the flags it fed, so nothing may reintroduce it.
test("release workflow carries no analytics env into npm publish", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /UMAMI/i);
  assert.doesNotMatch(buildScript, /UMAMI/i);
});
