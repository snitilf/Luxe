// Serve-from-dist smoke test (issue #30). The whole unit suite imports src/ directly,
// so a missing dist asset - like the artifact-baseline.css omission that 500'd /sdk.js
// for every npm/npx install of 0.3.x - was invisible to CI. This script boots the BUILT
// bundle exactly the way a published install runs it and asserts every asset surface a
// session depends on.
//
// Usage: node scripts/smoke-dist.js [--cli <path-to-cli.mjs>] [--port <n>]
// The --cli parameter exists so the check can run against an arbitrary install (e.g. a
// published tarball's dist) as a negative control. The script refuses to run when the
// port already answers, so assertions can never green against a foreign server; pass
// --port to pick another.

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cliPath = path.resolve(argValue("--cli", "dist/cli.mjs"));
const port = Number(argValue("--port", "4673"));
const base = `http://127.0.0.1:${port}`;

const stateDir = await mkdtemp(path.join(tmpdir(), "luxe-dist-smoke-"));
const artifact = path.join(stateDir, "smoke.html");
await writeFile(artifact, "<!doctype html><html><body><h1>smoke</h1></body></html>");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const stderrChunks = [];
let child = null;
/** @type {Error | null} */
let spawnError = null;
try {
  // Never assert against a foreign server that already owns the port.
  try {
    const occupied = await fetch(`${base}/chrome.css`);
    if (occupied.status === 200) {
      console.error(`port ${port} already serves a Luxe server - pass --port to pick another`);
      process.exit(1);
    }
  } catch {
    // nothing listening: good
  }

  child = spawn(process.execPath, [cliPath, "server", "--port", String(port)], {
    env: { ...process.env, LUXE_STATE_DIR: stateDir, LUXE_NO_OPEN: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  // Wait for the server to listen (or die trying).
  const deadline = Date.now() + 20_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const probe = await fetch(`${base}/chrome.css`);
      if (probe.status === 200) {
        up = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!up) {
    check(
      "server boots",
      false,
      `exit=${child.exitCode} spawnError=${spawnError ? spawnError.message : "none"} stderr=${Buffer.concat(stderrChunks).toString().slice(0, 400)}`,
    );
    throw new Error("server never came up");
  }
  check("server boots", true);

  const open = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  });
  check("session opens", open.status === 200, `status=${open.status}`);
  const { key } = await open.json();

  // The surface that broke in #30: the SDK bundle, with the baseline stylesheet embedded.
  const sdk = await fetch(`${base}/sdk.js?key=${key}`);
  const sdkBody = await sdk.text();
  check("/sdk.js 200", sdk.status === 200, `status=${sdk.status}`);
  check("/sdk.js is the full bundle", sdkBody.length > 100_000, `${sdkBody.length} bytes`);
  check("/sdk.js embeds the artifact baseline", sdkBody.includes("luxe-baseline"));

  // The boot check (#21) must stay silent: a healthy dist warns about nothing.
  const bootLog = Buffer.concat(stderrChunks).toString();
  check("no asset warnings at boot", !/could not be read|\/sdk\.js failed/.test(bootLog), bootLog.slice(0, 300));

  // Chrome assets.
  const chromeCss = await fetch(`${base}/chrome.css`);
  check(
    "/chrome.css 200 with inlined tokens",
    chromeCss.status === 200 && (await chromeCss.text()).includes("--text-heading"),
  );
  const chromeClient = await fetch(`${base}/chrome-client.js`);
  check("/chrome-client.js 200", chromeClient.status === 200 && (await chromeClient.text()).length > 50_000);

  // Fonts.
  const font = await fetch(`${base}/fonts/inter-latin-400-normal.woff2`);
  check(
    "/fonts serves woff2",
    font.status === 200 && (font.headers.get("content-type") || "").includes("font/woff2"),
    `status=${font.status} type=${font.headers.get("content-type")}`,
  );

  // Whiteboard bundle (dist/whiteboard, resolved against the bundle location).
  const whiteboardJs = await fetch(`${base}/whiteboard-assets/whiteboard.js`);
  check(
    "/whiteboard-assets/whiteboard.js 200",
    whiteboardJs.status === 200 && (await whiteboardJs.text()).length > 10_000,
  );
  const whiteboardFont = await fetch(`${base}/whiteboard-assets/fonts/Assistant/Assistant-Regular.woff2`);
  check("whiteboard font 200", whiteboardFont.status === 200, `status=${whiteboardFont.status}`);

  // The artifact page injects the SDK.
  const page = await fetch(`${base}/artifact/${key}/index.html`);
  check("artifact page injects sdk.js", page.status === 200 && (await page.text()).includes("/sdk.js?key="));

  // The standalone export embeds the baseline stylesheet (second baseline consumer).
  const exported = await fetch(`${base}/api/${key}/export`);
  const exportBody = await exported.text();
  check(
    "export embeds the baseline",
    exported.status === 200 && exportBody.includes('id="luxe-baseline"'),
    `status=${exported.status}`,
  );

  // `luxe design` embeds the baseline snippet too (third baseline consumer).
  const design = spawnSync(process.execPath, [cliPath, "design"], { encoding: "utf8" });
  check("`luxe design` embeds the baseline", design.status === 0 && design.stdout.includes("luxe-baseline"));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(stateDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\ndist smoke test FAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\ndist smoke test passed");
