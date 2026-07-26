import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
