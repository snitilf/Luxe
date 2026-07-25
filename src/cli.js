import { readFileSync } from "node:fs";

export const VERSION =
  process.env.LUXE_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export async function run(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (argv.includes("--help") || argv.length === 0) {
    console.log("Luxe skill CLI\n\nUsage: luxe [--version|--help]");
    return;
  }
  console.log("Unknown command. Use --help.");
}

export function normalizeArgv(argv) {
  return argv;
}
