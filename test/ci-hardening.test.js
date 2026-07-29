import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("the hosted Chrome regression is force-killed after its deadline", async () => {
  const source = await read("test/whiteboard-render.browser.test.js");

  // Chrome with --dump-dom never exits on its own, so the regression must always hold a finite
  // deadline and always end the process itself, whether the dump arrived or the deadline did.
  assert.match(source, /const chromeTimeoutMs = \d[\d_]*;/);
  assert.match(source, /setTimeout\(\(\) => finish\(true\), chromeTimeoutMs\)/);
  assert.match(source, /child\.kill\("SIGKILL"\)/);
});

test("the hosted Chrome regression tears its fixture down without masking the failure", async () => {
  const source = await read("test/whiteboard-render.browser.test.js");

  // Killing Chrome is not the same as Chrome having exited, and a Chrome that is still
  // flushing writes into the profile directory turns the removal into an ENOTEMPTY. So the
  // run must wait for a real, bounded exit, and the removal must retry rather than trust the
  // first walk.
  assert.match(source, /const chromeExitGraceMs = \d[\d_]*;/);
  assert.match(source, /waitForExit\(\)/);
  assert.match(source, /maxRetries: cleanupRetries/);
  assert.match(source, /retryDelay: cleanupRetryDelayMs/);

  // And the teardown must never throw. A `finally` that throws replaces the assertion that
  // actually failed, so a temp-directory error would be reported in place of whatever the
  // render did wrong - the half of this bug that cost the most to diagnose.
  assert.match(source, /\}\)\.catch\(\(error\) => \{\s*t\.diagnostic\(/);
});

test("every GitHub Actions job has a finite timeout", async () => {
  const workflows = [
    ".github/workflows/ci.yml",
    ".github/workflows/guard-generated-files.yml",
    ".github/workflows/release-please.yml",
  ];

  for (const workflowPath of workflows) {
    const source = await read(workflowPath);
    const jobs = source.slice(source.indexOf("\njobs:\n") + 7);
    const jobCount = (jobs.match(/^ {2}[a-z][a-z0-9-]*:\s*$/gm) ?? []).length;
    const timeoutCount = (jobs.match(/^ {4}timeout-minutes:\s*[1-9]\d*\s*$/gm) ?? []).length;

    assert.ok(jobCount > 0, `${workflowPath} must define at least one job`);
    assert.equal(timeoutCount, jobCount, `${workflowPath} must bound every job`);
  }
});
