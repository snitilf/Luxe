import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as esbuild from "esbuild";
import { parse } from "parse5";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// Virtual time the fixture is given to load Excalidraw, convert the diagrams, await the
// webfont and rasterise the canvas. Chrome emits the --dump-dom output once this is spent.
const virtualTimeBudgetMs = 8_000;
// Wall-clock ceiling on the whole Chrome process. Chrome with --dump-dom writes the dump and
// then never exits on its own, so this is a backstop for "the dump never arrived", not the
// normal exit path: runChromeDump returns as soon as the dump is complete. That makes the
// budget free to be generous, and generous is what a contended CI runner needs - a shared
// ubuntu runner has been observed spending over 18s here while macOS and Windows spent ~3s.
const chromeTimeoutMs = 45_000;
// How long to wait for Chrome to be reaped after it is killed. SIGKILL is already the
// strongest signal there is, so this is not a step on the way to a harder kill: it is the
// point at which waiting stops being useful and the retrying rm below takes over. Generous
// enough that a contended runner never trips it, short enough that a wedged Chrome cannot
// push the run anywhere near the node:test ceiling.
const chromeExitGraceMs = 5_000;
const maxDumpBytes = 8 * 1024 * 1024;
// Chrome keeps writing into its --user-data-dir right up to the moment it dies, and on a
// contended runner some of those writes land after the process has been killed. A removal
// that walks a directory another process is still creating files in fails the final rmdir
// with ENOTEMPTY, so the walk is retried rather than trusted the first time.
const cleanupRetries = 10;
const cleanupRetryDelayMs = 100;
// Chrome is chatty on stderr and a broken install can be endlessly chatty, so the stream is
// always drained but only its tail is retained: enough to carry the actual loader or sandbox
// error into the assertion message, small enough that it can never flood one.
const maxStderrTailBytes = 4 * 1024;

/**
 * Runs Chrome with --dump-dom and returns as soon as the serialised document has been
 * written, killing Chrome at that point instead of waiting for an exit that never comes.
 *
 * Killing is not the same as having exited: child.kill only delivers the signal, and Chrome
 * is still flushing writes into its --user-data-dir when it returns. Handing that directory
 * to a caller that removes it immediately turns a successful render into an ENOTEMPTY on the
 * temp directory, so this waits for the process to actually be reaped before returning, and
 * reports whether it was - a Chrome that never dies is bounded, not waited on forever.
 *
 * stderr and the exit status come back alongside the dump so that a Chrome which never
 * managed to render can be diagnosed as a launch failure rather than an empty document.
 *
 * @param {string} chrome
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, signal: NodeJS.Signals | null, timedOut: boolean, exited: boolean }>}
 */
function runChromeDump(chrome, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let code = null;
    let signal = null;
    let settled = false;
    let hasExited = false;
    /**
     * Resolves true once the OS has reaped Chrome, false if it is still alive after the
     * grace window. SIGKILL has already been sent by then, so there is no harder signal to
     * escalate to; the caller's retrying cleanup is what absorbs the leftover writes.
     *
     * @returns {Promise<boolean>}
     */
    const waitForExit = () =>
      new Promise((settle) => {
        if (hasExited) return settle(true);
        function onExit() {
          clearTimeout(graceTimer);
          settle(true);
        }
        const graceTimer = setTimeout(() => {
          child.off("exit", onExit);
          settle(false);
        }, chromeExitGraceMs);
        child.once("exit", onExit);
      });
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      waitForExit().then((exited) => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ stdout, stderr, code, signal, timedOut, exited });
      });
    };
    const timer = setTimeout(() => finish(true), chromeTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // --dump-dom writes the document in one shot; the closing tag means it is complete and
      // safe to parse, so there is no reason to keep Chrome alive any longer.
      if (stdout.includes("</html>") || stdout.length >= maxDumpBytes) finish(false);
    });
    child.stderr.setEncoding("utf8");
    // Reading every chunk is what keeps the pipe from filling and deadlocking Chrome; the
    // trimming happens after the read, never by pausing or ignoring the stream.
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-maxStderrTailBytes);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Chrome could not be launched from ${chrome}: ${error.message}`, { cause: error }));
    });
    // exit fires the moment the process is reaped, which is exactly the fact the cleanup
    // depends on, so the status is recorded here rather than waiting for the pipes to drain.
    child.on("exit", (exitCode, exitSignal) => {
      hasExited = true;
      code = exitCode;
      signal = exitSignal;
    });
    // close fires once Chrome has exited and both pipes have drained, so the stderr tail is
    // complete by the time a Chrome that ended on its own is turned into a diagnosis.
    child.on("close", () => finish(false));
  });
}

/**
 * Explains a Chrome run that produced no complete DOM dump and did not run out of time,
 * which means Chrome itself failed: a bad flag, a missing shared library, a sandbox refusal
 * or a broken install on the CI image.
 *
 * @param {{ stdout: string, stderr: string, code: number | null, signal: NodeJS.Signals | null }} run
 */
function chromeFailureMessage({ stdout, stderr, code, signal }) {
  const status = signal ? `was killed by ${signal}` : `exited with code ${code}`;
  const tail = stderr.trim() === "" ? "<empty>" : `\n${stderr.trim()}`;
  return [
    `Chrome failed to produce a DOM dump: it ${status} after writing ${stdout.length} bytes to stdout.`,
    "This is a Chrome launch or startup failure, not a rendering failure.",
    `Chrome stderr (last ${maxStderrTailBytes} bytes): ${tail}`,
  ].join(" ");
}

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return "";
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function resultFromDump(html) {
  const document = parse(html);
  const stack = /** @type {import("parse5").DefaultTreeAdapterMap["node"][]} */ ([document]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeName === "body") {
      const element = /** @type {import("parse5").DefaultTreeAdapterMap["element"]} */ (node);
      const attribute = element.attrs.find((item) => item.name === "data-result");
      if (attribute) return JSON.parse(attribute.value);
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  return null;
}

// The node:test ceiling below stays well above chromeTimeoutMs plus the esbuild bundle and the
// font copy that precede it, so the Chrome budget is always the timeout that fires first and the
// failure is always diagnosed rather than reported as a bare, uninformative test timeout.
test("real Excalidraw rendering keeps loaded-font labels inside their text bounds", { timeout: 75_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the real-render regression");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "luxe-excalidraw-render-"));
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "test/fixtures/excalidraw-label-clipping.browser.jsx")],
      outdir: root,
      entryNames: "fixture",
      assetNames: "assets/[name]-[hash]",
      bundle: true,
      format: "iife",
      platform: "browser",
      conditions: ["production"],
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.IS_PREACT": '"false"',
      },
    });
    await cp(
      path.join(projectRoot, "node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
      path.join(root, "whiteboard-assets/fonts"),
      { recursive: true },
    );
    await writeFile(
      path.join(root, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><script src="/fixture.js"></script></body></html>',
    );
    const server = http.createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
        const file = path.resolve(root, relative);
        if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("outside fixture root");
        const body = await readFile(file);
        response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
      const port = address.port;
      const profile = path.join(root, "chrome-profile");
      const args = [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        `--user-data-dir=${profile}`,
        "--run-all-compositor-stages-before-draw",
        `--virtual-time-budget=${virtualTimeBudgetMs}`,
        "--dump-dom",
        `http://127.0.0.1:${port}/`,
      ];
      const run = await runChromeDump(chrome, args);
      const { stdout, timedOut } = run;
      // Giving up on the exit is survivable - the retrying cleanup below is built for it -
      // but it is never normal, so it is said out loud rather than absorbed in silence.
      if (!run.exited) {
        t.diagnostic(`Chrome was still alive ${chromeExitGraceMs}ms after SIGKILL; leaving it to the cleanup retries`);
      }
      const dumpComplete = stdout.includes("</html>");
      const result = dumpComplete ? resultFromDump(stdout) : null;
      // These three are different diagnoses and must read differently. A timeout says nothing
      // about fonts, glyph metrics or bounds, and sending a reader after those wastes an hour;
      // a Chrome that never started says nothing about the fixture at all, so the fixture
      // message is reserved for a Chrome that really did hand back a finished document.
      assert.ok(
        result,
        timedOut
          ? `Chrome exceeded its ${chromeTimeoutMs / 1000}s budget before the fixture reported; this is a timing failure, not a rendering failure`
          : dumpComplete
            ? "browser fixture did not report a result: Chrome finished but its DOM dump carried no data-result"
            : chromeFailureMessage(run),
      );
      assert.equal(result.pass, true, result.error);
      assert.equal(result.fontReady, true);
      assert.equal(result.edgeLabels, 4);
      assert.ok(result.multilineLines >= 2);
      assert.ok(result.repaired >= 5);
      assert.ok(result.opaquePixels >= 1000);
      assert.deepEqual(result.nativeConversions, {
        subgraph: true,
        class: true,
        er: true,
        state: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    // Two rules for this teardown. It retries, because Chrome can still be creating files
    // under the profile directory while the walk is emptying it and the final rmdir then
    // fails with ENOTEMPTY. And it never throws, because a `finally` that throws replaces
    // whatever the body threw: an ENOTEMPTY on a temp directory would stand in for the
    // assertion the reader actually needs, which is how a green render once got reported as
    // a filesystem error. A directory that survives both is a leak worth naming, not a
    // reason to fail a run that already told the truth about the render.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: cleanupRetries,
      retryDelay: cleanupRetryDelayMs,
    }).catch((error) => {
      t.diagnostic(`could not remove the fixture directory ${root}: ${error.message}`);
    });
  }
});
