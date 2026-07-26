// Real-browser checks for the diagram toolbar.
//
// The thing this replaced - an absolutely positioned "Edit as whiteboard" button pinned
// inside the diagram container - was reported by a human looking at a screen, and no
// amount of source reading would have caught it. Geometry, hit targets, clamp ends and
// snapshot exclusion are all facts about a rendered page, so they are asserted against
// one. Gated on LUXE_BROWSER_E2E=1 like the layout audit E2E, since it needs Chrome.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LUXE_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return port;
}

// A wide flowchart: the shape where the old top-right button landed on a node.
const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Diagram toolbar</title></head>
<body>
<pre class="mermaid">
flowchart LR
  A[Client] --> B[Chrome]
  B --> C[Artifact SDK]
  C --> D[Snapshot]
  D --> E[Server]
  E --> F[Agent poll]
</pre>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, theme: "base", securityLevel: "strict" });
await mermaid.run({ nodes: [...document.querySelectorAll(".mermaid")] });
</script>
</body></html>`;

test(
  "the diagram toolbar sits below the diagram and drives the viewport",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "luxe-toolbar-browser-"));
    const port = await freePort();
    const luxeEnv = {
      LUXE_PORT: String(port),
      LUXE_STATE_DIR: path.join(temp, "state"),
      LUXE_NO_OPEN: "1",
      LUXE_HOST: "127.0.0.1",
      LUXE_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `luxe-toolbar-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    try {
      const file = path.join(temp, "diagram.html");
      await writeFile(file, ARTIFACT);
      const output = run(process.execPath, ["bin/luxe.js", file, "--no-open"], luxeEnv);
      const sessionUrl = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(sessionUrl, output);
      // Drive the artifact route directly: the session's iframe is sandboxed without
      // allow-same-origin, so the parent page cannot script into it.
      const artifactUrl = sessionUrl.replace("/session/", "/artifact/") + "/index.html";

      // The CLI prints `result: "<json-encoded string>"` on one line, then unrelated help
      // text. Match to end of LINE, not end of output: a greedy dot-all capture swallows
      // the help block and yields undefined fields that quietly pass some assertions.
      // The CLI prints `result: <payload>` on one line, then unrelated help text. Match to
      // end of LINE, not end of output: a greedy dot-all capture swallows the help block.
      // The payload arrives JSON-encoded more than once - the eval returns a string, and
      // the CLI encodes it again - so unwrap until an object falls out rather than
      // hard-coding a nesting depth that varies with how the value was produced.
      const evaluate = (fn) => {
        const output = run("chrome-devtools-axi", ["eval", fn], chromeEnv);
        const line = output.match(/^result: (.*)$/m);
        assert.ok(line, `no result line in chrome-devtools-axi output:\n${output}`);
        let value = line[1].trim();
        for (let depth = 0; depth < 4 && typeof value === "string"; depth += 1) {
          value = JSON.parse(value);
        }
        assert.ok(value && typeof value === "object", `unexpected eval payload: ${line[1]}`);
        return /** @type {Record<string, any>} */ (value);
      };

      for (const viewport of ["1440x900", "768x900"]) {
        run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
        run("chrome-devtools-axi", ["open", artifactUrl], chromeEnv);
        run("chrome-devtools-axi", ["wait", "3000"], chromeEnv);

        const geometry = evaluate(`() => {
        const bar = document.querySelector('[role=toolbar]');
        const svg = document.querySelector('.mermaid svg');
        const b = bar.getBoundingClientRect(), s = svg.getBoundingClientRect();
        const buttons = [...bar.querySelectorAll('button')].map((x) => ({
          name: x.getAttribute('aria-label') || x.textContent,
          h: Math.round(x.getBoundingClientRect().height),
        }));
        return JSON.stringify({ overlaps: b.top < s.bottom - 1, buttons });
      }`);

        assert.equal(geometry.overlaps, false, `the toolbar overlaps the diagram at ${viewport}`);
        for (const button of geometry.buttons) {
          assert.ok(button.name, `a toolbar control has no accessible name at ${viewport}`);
          assert.ok(button.h >= 24, `${button.name} is only ${button.h}px tall at ${viewport}`);
        }
      }

      // Zoom, reset, and both ends of the clamp.
      const zoom = evaluate(`() => {
      const bar = document.querySelector('[role=toolbar]');
      const [out, reset, zin] = [...bar.querySelectorAll('button')];
      const steps = { start: reset.textContent };
      zin.click();
      steps.zoomedIn = reset.textContent;
      reset.click();
      steps.afterReset = reset.textContent;
      steps.resetDisabledAtFit = reset.disabled;
      for (let i = 0; i < 30; i += 1) zin.click();
      steps.inClamp = reset.textContent;
      steps.zoomInDisabled = zin.disabled;
      reset.click();
      for (let i = 0; i < 30; i += 1) out.click();
      steps.outClamp = reset.textContent;
      steps.zoomOutDisabled = out.disabled;
      reset.click();
      return JSON.stringify(steps);
    }`);

      assert.equal(zoom.start, "100%");
      assert.equal(zoom.zoomedIn, "125%");
      assert.equal(zoom.afterReset, "100%");
      assert.equal(zoom.resetDisabledAtFit, true);
      assert.equal(zoom.inClamp, "4000%", "zoom in should stop at the 40x clamp");
      assert.equal(zoom.zoomInDisabled, true);
      assert.equal(zoom.outClamp, "13%", "zoom out should stop at the 8x clamp");
      assert.equal(zoom.zoomOutDisabled, true);

      // Keyboard, scoped to the toolbar, and never stealing the browser's own zoom.
      const keyboard = evaluate(`() => {
      const bar = document.querySelector('[role=toolbar]');
      const reset = [...bar.querySelectorAll('button')][1];
      const press = (key, ctrlKey = false) =>
        bar.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true }));
      press('+');
      const afterPlus = reset.textContent;
      press('0');
      const afterZero = reset.textContent;
      press('+', true);
      return JSON.stringify({ afterPlus, afterZero, ctrlIgnored: reset.textContent });
    }`);
      assert.notEqual(keyboard.afterPlus, "100%", "the + key should zoom");
      assert.equal(keyboard.afterZero, "100%", "the 0 key should reset to fit");
      assert.equal(keyboard.ctrlIgnored, "100%", "ctrl+plus belongs to the browser, not the toolbar");

      // Annotation mode retires the whiteboard button WITH a reason, and leaves zoom alone.
      const annotating = evaluate(`() => new Promise((resolve) => {
      const bar = document.querySelector('[role=toolbar]');
      const buttons = [...bar.querySelectorAll('button')];
      const edit = buttons[buttons.length - 1];
      window.postMessage({ type: 'luxe:setAnnotationMode', enabled: true }, '*');
      setTimeout(() => {
        const before = buttons[1].textContent;
        buttons[2].click();
        resolve(JSON.stringify({
          editDisabled: edit.disabled,
          reason: edit.title,
          zoomStillWorks: buttons[1].textContent !== before,
        }));
      }, 200);
    })`);
      assert.equal(annotating.editDisabled, true);
      assert.match(annotating.reason, /Turn off Annotate/);
      assert.equal(annotating.zoomStillWorks, true, "zoom is not gated on annotation mode");

      // Luxe-owned controls must never reach the agent.
      const snapshot = evaluate(`() => new Promise((resolve) => {
      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'luxe:snapshot') {
          const text = event.data.snapshot || '';
          resolve(JSON.stringify({
            carriesDiagram: /Artifact SDK/.test(text),
            leaksToolbar: /diagram-toolbar|Zoom in|Zoom out|Reset zoom|Edit as whiteboard/.test(text),
          }));
        }
      });
      window.postMessage({ type: 'luxe:requestSnapshot' }, '*');
      setTimeout(() => resolve(JSON.stringify({ carriesDiagram: false, leaksToolbar: false })), 3000);
    })`);
      assert.equal(snapshot.carriesDiagram, true, "the snapshot should still carry the diagram");
      assert.equal(snapshot.leaksToolbar, false, "Luxe controls leaked into the agent's snapshot");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
