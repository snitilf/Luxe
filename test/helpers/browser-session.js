// Shutdown for the real-browser suites.
//
// Both gated suites start two long-lived things: a Luxe server on a port they picked, and
// a `chrome-devtools-axi` bridge process which in turn launches a Chrome. Neither dies
// with the test process, so a suite that returns without stopping them leaves a bridge and
// a browser behind on every run - invisible on a laptop until memory runs out, one leaked
// browser per run in CI.
import { spawnSync } from "node:child_process";

const STOP_TIMEOUT_MS = 15_000;

/**
 * Runs one shutdown command, reporting trouble instead of raising it.
 *
 * @param {string} what human-readable name of the thing being stopped
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
function stop(what, command, args, options) {
  try {
    const result = spawnSync(command, args, {
      ...options,
      encoding: "utf8",
      timeout: STOP_TIMEOUT_MS,
      // A global or node_modules/.bin binary resolves through a .cmd shim on Windows,
      // which spawnSync cannot find on its own. Same reason as the preflight probe in
      // scripts/run-browser-tests.js.
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`exited with ${result.status}\n${result.stdout || ""}${result.stderr || ""}`);
    }
  } catch (error) {
    // Never rethrow. This runs from a `finally`, and an error raised while unwinding
    // replaces the assertion failure that sent us here - which is the one thing the
    // reader actually needs. Say it happened, then let the original failure through.
    console.error(`warning: failed to stop the ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Stops the Luxe server and the chrome-devtools-axi bridge (and with it the Chrome the
 * bridge launched) started by a real-browser suite. Safe to call on the failure path:
 * it reports its own trouble on stderr and never throws.
 *
 * @param {object} session
 * @param {string} session.repoRoot
 * @param {number} session.port port the Luxe server was started on
 * @param {Record<string, string>} session.luxeEnv
 * @param {Record<string, string>} session.chromeEnv
 */
export function shutdownBrowserSession({ repoRoot, port, luxeEnv, chromeEnv }) {
  stop("Luxe server", process.execPath, ["bin/luxe.js", "stop", "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, ...luxeEnv },
  });
  stop("chrome-devtools-axi bridge", "chrome-devtools-axi", ["stop"], {
    cwd: repoRoot,
    env: { ...process.env, ...chromeEnv },
  });
}
