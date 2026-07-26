import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

test("the hosted Chrome regression is force-killed after its deadline", async () => {
  const source = await read("test/whiteboard-render.browser.test.js");

  assert.match(source, /timeout:\s*18_000/);
  assert.match(source, /killSignal:\s*"SIGKILL"/);
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
