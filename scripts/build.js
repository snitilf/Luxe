// Phase 1 interim build: bundles the stub CLI into dist/cli.mjs so the bin
// entry, prepack, and prepare are real. Phase 2 replaces this with the full
// build (server, SDK bundles, whiteboard, design assets).
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["bin/luxe.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/cli.mjs",
  define: {
    "process.env.LUXE_BUILD_VERSION": JSON.stringify(pkg.version),
  },
});
