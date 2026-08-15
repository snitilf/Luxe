// Real-browser checks for the diagram toolbar.
//
// The thing this replaced - an absolutely positioned "Edit as whiteboard" button pinned
// inside the diagram container - was reported by a human looking at a screen, and no
// amount of source reading would have caught it. Geometry, hit targets, clamp ends and
// snapshot exclusion are all facts about a rendered page, so they are asserted against
// one. Gated on LUXE_BROWSER_E2E=1 like the layout audit E2E, since it needs Chrome.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shutdownBrowserSession } from "./helpers/browser-session.js";

const runBrowserE2e = process.env.LUXE_BROWSER_E2E === "1";
// A silent `skip: true` reads as coverage in the test output while asserting nothing, so
// the reason names the command that actually runs these.
const skipReason = runBrowserE2e ? false : "real-browser suite, needs Chrome - run `npm run check:browser`";
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

// Two shapes, because the strip's alignment depends on which one it is under. The wide
// flowchart is where the old top-right button landed on a node. The narrow one is where
// aligning to the CONTAINER instead of the DIAGRAM parks the controls in empty space
// beside the thing they control - which looks perfectly correct under the wide one.
//
// The stylesheet is the one that matters as much as the diagrams: a bare
// `pre { background; border; border-radius }` is what every code-block theme ends in,
// including the snippet Luxe itself tells authors to paste. It paints every Mermaid
// diagram as a code block, and a zero-specificity repair loses to it.
//
// Mermaid is imported from a copy served next to the artifact rather than from a CDN. Real
// artifacts do use the CDN, but a test that fetches 13MB of unpinned JavaScript over the
// public internet before it can assert anything is a test that fails for reasons that have
// nothing to do with Luxe: this suite's long-standing intermittent failure on macOS was a
// `net::ERR_SOCKET_NOT_CONNECTED` on the jsdelivr request, after which mermaid.run never
// ran, no SVG appeared, and the toolbar this file is about was never injected. The version
// under test is the one in package.json, for the same reason chrome-devtools-mcp is pinned
// rather than fetched with `npx -y ...@latest`.
const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Diagram toolbar</title>
<style>
  pre, .mockup-code {
    background: #f7f4ec;
    border: 1px solid #e7e2d6;
    border-radius: 12px;
  }
</style>
</head>
<body>
<pre class="mermaid" id="wide">
flowchart LR
  A[Client] --> B[Chrome]
  B --> C[Artifact SDK]
  C --> D[Snapshot]
  D --> E[Server]
  E --> F[Agent poll]
</pre>
<pre class="mermaid" id="narrow">
flowchart TD
  X[Start] --> Y[Stop]
</pre>
<pre id="code">const answer = 42;</pre>
<script type="module">
import mermaid from "./mermaid/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, theme: "base", securityLevel: "strict" });
await mermaid.run({ nodes: [...document.querySelectorAll(".mermaid")] });
</script>
</body></html>`;

let toolbarSessionCounter = 0;

// Both suites in this file drive the same artifact through the same server-plus-bridge
// rig, so the rig lives here once. startToolbarSession leaves the browser ON the artifact
// route: the session's iframe is sandboxed without allow-same-origin, so the parent page
// cannot script into it.
async function startToolbarSession() {
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
    CHROME_DEVTOOLS_AXI_SESSION: `luxe-toolbar-${process.pid}-${++toolbarSessionCounter}`,
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
  };
  const file = path.join(temp, "diagram.html");
  await writeFile(file, ARTIFACT);
  // The artifact route serves siblings of the artifact file, so the Mermaid bundle only
  // has to land beside it. Both halves are needed: the entry module lazy-imports one
  // chunk per diagram type from `chunks/mermaid.esm.min/`, and a missing chunk fails at
  // render time rather than at import time.
  const mermaidDist = path.join(repoRoot, "node_modules", "mermaid", "dist");
  const mermaidDir = path.join(temp, "mermaid");
  await mkdir(mermaidDir, { recursive: true });
  await cp(path.join(mermaidDist, "mermaid.esm.min.mjs"), path.join(mermaidDir, "mermaid.esm.min.mjs"));
  await cp(path.join(mermaidDist, "chunks", "mermaid.esm.min"), path.join(mermaidDir, "chunks", "mermaid.esm.min"), {
    recursive: true,
  });
  const output = run(process.execPath, ["bin/luxe.js", file, "--no-open"], luxeEnv);
  const sessionUrl = output.match(/url:\s*"([^"]+)"/)?.[1];
  assert.ok(sessionUrl, output);
  const artifactUrl = sessionUrl.replace("/session/", "/artifact/") + "/index.html";
  run("chrome-devtools-axi", ["open", artifactUrl], chromeEnv);
  return { temp, port, luxeEnv, chromeEnv, artifactUrl };
}

async function stopToolbarSession({ temp, port, luxeEnv, chromeEnv }) {
  // The bridge and the Chrome it launched outlive this process, so they have to be
  // stopped here rather than left to the temp-directory sweep. The helper reports its
  // own trouble instead of throwing, so a shutdown hiccup cannot replace the
  // assertion failure that brought us into this block.
  shutdownBrowserSession({ repoRoot, port, luxeEnv, chromeEnv });
  await rm(temp, { recursive: true, force: true });
}

function makeEvaluate(chromeEnv) {
  // The CLI prints `result: <payload>` on one line, then unrelated help text. Match to
  // end of LINE, not end of output: a greedy dot-all capture swallows the help block and
  // yields undefined fields that quietly pass some assertions.
  const resultPayload = (fn) => {
    const output = run("chrome-devtools-axi", ["eval", fn], chromeEnv);
    const line = output.match(/^result: (.*)$/m);
    assert.ok(line, `no result line in chrome-devtools-axi output:\n${output}`);
    return { payload: line[1].trim(), output };
  };

  // The payload arrives JSON-encoded more than once - the eval returns a string, and the
  // CLI encodes it again - so unwrap until an object falls out rather than hard-coding a
  // nesting depth that varies with how the value was produced. Returns undefined for
  // anything that is not JSON at all, which is what an in-page throw looks like: the CLI
  // reports it as the bare string `Error: <message>`.
  const unwrap = (payload) => {
    let value = payload;
    for (let depth = 0; depth < 4 && typeof value === "string"; depth += 1) {
      try {
        value = JSON.parse(value);
      } catch {
        return undefined;
      }
    }
    return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : undefined;
  };

  const tryEvaluate = (fn) => unwrap(resultPayload(fn).payload);

  const evaluate = (fn) => {
    const { payload, output } = resultPayload(fn);
    const value = unwrap(payload);
    // Reporting the payload is the whole point of this branch. Left to JSON.parse, an
    // in-page `Error: Cannot read properties of null ...` surfaced as
    // `SyntaxError: Unexpected token 'E', "Error: Can"... is not valid JSON` - the parser
    // quotes ten characters and throws the message that names the actual failure away,
    // which is an hour of debugging for a payload that was self-explanatory all along.
    assert.ok(
      value,
      `chrome-devtools-axi eval did not return a JSON object.\npayload: ${payload}\n\nfull output:\n${output}`,
    );
    return value;
  };

  return { evaluate, tryEvaluate };
}

// Mermaid renders asynchronously and Luxe injects each toolbar only once the SVG it
// belongs to has laid out, so "the page is ready" is a fact to observe, not a duration
// to guess. The fixed `wait 3000` this replaced turned every slow render into an
// assertion about a null element, which is a failure that describes the symptom and
// not the cause.
function waitForToolbars({ chromeEnv, tryEvaluate, label, expected = 2 }) {
  const probe = `() => JSON.stringify({
    containers: document.querySelectorAll('.mermaid').length,
    ready: [...document.querySelectorAll('.mermaid')].filter(
      (el) => el.querySelector('svg') && el.querySelector('[role=toolbar] button'),
    ).length,
  })`;
  const deadline = Date.now() + 60_000;
  // No initialiser: the loop body runs at least once and always describes what it saw.
  let last;
  do {
    const state = tryEvaluate(probe);
    if (state) {
      if (state.containers === expected && state.ready === expected) return;
      last = `${state.ready}/${state.containers} container(s) rendered with a toolbar`;
    } else {
      last = "the readiness probe itself did not return JSON";
    }
    run("chrome-devtools-axi", ["wait", "500"], chromeEnv);
  } while (Date.now() < deadline);
  // A stalled render is almost always something the page already complained about -
  // a blocked CDN import, a Mermaid parse error - so the browser console goes into
  // the failure rather than leaving the next reader to reproduce it by hand.
  const console_ = run("chrome-devtools-axi", ["console"], chromeEnv);
  assert.fail(`the diagrams never rendered with their toolbars at ${label}: ${last}\n\n${console_}`);
}

test(
  "the diagram toolbar sits below the diagram and drives the viewport",
  // Same ceiling as the layout audit suite: sized for a slow shared runner, so it only
  // trips on a genuine hang. See the browser-tests job budget in .github/workflows/ci.yml.
  { skip: skipReason, timeout: 720_000 },
  async () => {
    const session = await startToolbarSession();
    const { chromeEnv } = session;
    const { evaluate, tryEvaluate } = makeEvaluate(chromeEnv);

    try {
      for (const viewport of ["1440x900", "768x900"]) {
        run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
        run("chrome-devtools-axi", ["open", session.artifactUrl], chromeEnv);
        waitForToolbars({ chromeEnv, tryEvaluate, label: viewport });

        const geometry = evaluate(`() => {
        const diagrams = [...document.querySelectorAll('.mermaid')].map((container) => {
          const bar = container.querySelector('[role=toolbar]');
          const svg = container.querySelector('svg');
          const group = container.querySelector('[role=group]');
          const cs = getComputedStyle(container);
          const b = bar.getBoundingClientRect(), s = svg.getBoundingClientRect();
          const controls = [...bar.querySelectorAll('button')];
          const first = controls[0].getBoundingClientRect();
          const last = controls[controls.length - 1].getBoundingClientRect();
          return {
            id: container.id,
            overlaps: b.top < s.bottom - 1,
            padTop: parseFloat(cs.paddingTop),
            padLeft: parseFloat(cs.paddingLeft),
            // Distance from each end of the control run to the matching end of the
            // DIAGRAM. One of the two is what the strip is anchored to.
            rightEdgeDelta: Math.round(last.right - s.right),
            leftEdgeDelta: Math.round(first.left - s.left),
            groups: container.querySelectorAll('[role=group]').length,
            groupBorder: group ? getComputedStyle(group).borderTopWidth : null,
            buttons: controls.map((x) => {
              const r = x.getBoundingClientRect(), s2 = getComputedStyle(x);
              return {
                name: x.getAttribute('aria-label') || x.textContent,
                w: Math.round(r.width),
                h: Math.round(r.height),
                bg: s2.backgroundColor,
              };
            }),
          };
        });
        return JSON.stringify({ diagrams });
      }`);

        for (const diagram of geometry.diagrams) {
          const where = `${diagram.id} at ${viewport}`;
          assert.equal(diagram.overlaps, false, `the toolbar overlaps the diagram: ${where}`);
          assert.ok(diagram.padTop >= 16, `the diagram has no room above it: ${where}`);
          assert.ok(diagram.padLeft >= 12, `the diagram has no room beside it: ${where}`);
          // One segmented object for the three zoom controls, not three loose buttons.
          assert.equal(diagram.groups, 1, `the zoom controls are not one segmented object: ${where}`);
          assert.notEqual(diagram.groupBorder, "0px", `the segmented control has no boundary: ${where}`);
          // Anchored to the DIAGRAM at one end or the other. Container-relative alignment
          // passes under a wide diagram and strands the controls beside a narrow one, so
          // this is asserted against the SVG's own box and on both shapes.
          assert.ok(
            Math.abs(diagram.rightEdgeDelta) <= 2 || Math.abs(diagram.leftEdgeDelta) <= 2,
            `the strip is not anchored to the diagram (left ${diagram.leftEdgeDelta}px, right ` +
              `${diagram.rightEdgeDelta}px from its edges): ${where}`,
          );
          for (const button of diagram.buttons) {
            assert.ok(button.name, `a toolbar control has no accessible name: ${where}`);
            // 32px, not the 24px WCAG 2.5.8 floor: the larger target is a recorded decision,
            // and quieting these controls visually is not allowed to shrink it.
            assert.ok(button.h >= 32, `${button.name} is only ${button.h}px tall: ${where}`);
            assert.ok(button.w >= 32, `${button.name} is only ${button.w}px wide: ${where}`);
            // Unfilled at rest. The boundary carries the affordance, not a fill.
            assert.match(button.bg, /rgba\(0, 0, 0, 0\)|transparent/, `${button.name} is filled at rest: ${where}`);
          }
        }
      }

      // The lit state, measured as contrast rather than trusted as a colour name. The
      // treatment this replaced was --surface-1, which is a real token, is applied by a
      // real rule, and is invisible: 1.04:1 against the canvas.
      const lit = evaluate(`() => {
      const luminance = (colour) => {
        const [r, g, b] = colour.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const surfaceBehind = (el) => {
        let node = el.parentElement;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) return bg;
          node = node.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      const button = document.querySelector('[role=toolbar] button');
      const surface = surfaceBehind(button);
      const resting = getComputedStyle(button).backgroundColor;
      button.focus();
      const cs = getComputedStyle(button);
      return JSON.stringify({
        focusVisible: button.matches(':focus-visible'),
        restingIsUnfilled: /rgba\\(0, 0, 0, 0\\)/.test(resting),
        litVsSurface: contrast(cs.backgroundColor, surface),
        glyphOnLit: contrast(cs.color, cs.backgroundColor),
        outline: cs.outlineStyle + ' ' + cs.outlineWidth,
        outlineOffset: cs.outlineOffset,
      });
    }`);
      assert.equal(lit.focusVisible, true);
      assert.equal(lit.restingIsUnfilled, true, "the control is filled at rest");
      assert.ok(
        lit.litVsSurface >= 3,
        `the lit state is ${lit.litVsSurface.toFixed(2)}:1 against the surface behind it, which nobody can see`,
      );
      assert.ok(lit.glyphOnLit >= 4.5, `the glyph is ${lit.glyphOnLit.toFixed(2)}:1 on the lit fill`);
      assert.match(lit.outline, /solid \d/, "the focus ring is missing");
      assert.notEqual(lit.outlineOffset, "0px", "the focus ring lost its offset");

      // The disabled readout, which is the state the page loads in: "100%" is showing and
      // resetting to fit is a no-op. Its contrast is not exempt just because it is disabled.
      const readout = evaluate(`() => {
      const luminance = (colour) => {
        const [r, g, b] = colour.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const bar = document.querySelector('[role=toolbar]');
      const [out, reset] = [...bar.querySelectorAll('button')];
      const surface = 'rgb(255, 255, 255)';
      const atFit = { disabled: reset.disabled, text: reset.textContent, ink: contrast(getComputedStyle(reset).color, surface) };
      for (let i = 0; i < 40; i += 1) out.click();
      const clamped = { disabled: out.disabled, ink: contrast(getComputedStyle(out).color, surface) };
      reset.click();
      return JSON.stringify({ atFit, clamped });
    }`);
      assert.equal(readout.atFit.disabled, true, "the reset control no longer disables at fit");
      assert.equal(readout.atFit.text, "100%");
      assert.ok(
        readout.atFit.ink >= 4.5,
        `the zoom readout is ${readout.atFit.ink.toFixed(2)}:1 while disabled, and it is disabled on load`,
      );
      assert.equal(readout.clamped.disabled, true, "zoom out no longer disables at the clamp");
      assert.ok(readout.clamped.ink >= 3, `a clamped control is ${readout.clamped.ink.toFixed(2)}:1 and unreadable`);

      // The code-block frame. The fixture's `pre` rule paints a border and an inset fill
      // around every <pre> on the page, which for a Mermaid diagram means drawing a picture
      // inside a code block. Luxe undoes it on the diagrams and must not touch real code.
      const framing = evaluate(`() => {
      const describe = (el) => {
        const cs = getComputedStyle(el);
        return {
          background: cs.backgroundColor,
          borderWidth: cs.borderTopWidth,
          borderRadius: cs.borderTopLeftRadius,
          paddingTop: cs.paddingTop,
          marked: el.hasAttribute('data-luxe-diagram'),
        };
      };
      return JSON.stringify({
        wide: describe(document.getElementById('wide')),
        narrow: describe(document.getElementById('narrow')),
        code: describe(document.getElementById('code')),
      });
    }`);

      for (const id of ["wide", "narrow"]) {
        const diagram = framing[id];
        assert.equal(diagram.marked, true, `${id} was never marked as a rendered diagram`);
        assert.match(
          diagram.background,
          /rgba\(0, 0, 0, 0\)|transparent/,
          `${id} still carries the code-block fill behind the diagram`,
        );
        assert.equal(diagram.borderWidth, "0px", `${id} still carries the code-block border around the diagram`);
        assert.equal(diagram.borderRadius, "0px", `${id} still carries the code-block corner radius`);
        // The reset must not take the breathing room with it.
        assert.equal(diagram.paddingTop, "20px", `${id} lost its padding to the frame reset`);
      }
      // A real code block is a real code block. The repair is scoped, not a global restyle.
      assert.equal(framing.code.marked, false, "a plain code block was marked as a diagram");
      assert.doesNotMatch(
        framing.code.background,
        /rgba\(0, 0, 0, 0\)/,
        "the repair stripped a real code block's fill",
      );
      assert.equal(framing.code.borderWidth, "1px", "the repair stripped a real code block's border");
      assert.equal(framing.code.borderRadius, "12px", "the repair stripped a real code block's corner radius");

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
        if (event.data && event.data.type === 'luxe:snapshot' && event.data.requestId === 1) {
          const text = event.data.snapshot || '';
          resolve(JSON.stringify({
            carriesDiagram: /Artifact SDK/.test(text),
            leaksToolbar: /diagram-toolbar|Diagram zoom|Zoom in|Zoom out|Reset zoom|Edit as whiteboard/.test(text),
          }));
        }
      });
      window.postMessage({ type: 'luxe:requestSnapshot', requestId: 1 }, '*');
      setTimeout(() => resolve(JSON.stringify({ carriesDiagram: false, leaksToolbar: false })), 3000);
    })`);
      assert.equal(snapshot.carriesDiagram, true, "the snapshot should still carry the diagram");
      assert.equal(snapshot.leaksToolbar, false, "Luxe controls leaked into the agent's snapshot");
    } finally {
      await stopToolbarSession(session);
    }
  },
);

test(
  "an idle page with rendered toolbars does not mutate the DOM",
  // Regression for the self-triggered re-render loop (issue #20): the toolbar's own state
  // writes used to retrigger the document-wide mermaid observer, measured at ~1-2k
  // mutations/sec on an idle page, and visible as oscillating layout when artifact CSS made
  // the toolbar and the SVG compete for width.
  { skip: skipReason, timeout: 720_000 },
  async () => {
    const session = await startToolbarSession();
    const { chromeEnv } = session;
    const { evaluate, tryEvaluate } = makeEvaluate(chromeEnv);
    try {
      waitForToolbars({ chromeEnv, tryEvaluate, label: "the churn probe" });
      // Let post-render stragglers (font swaps, the first announce write) land before
      // counting, so the assertion measures the steady state rather than startup.
      run("chrome-devtools-axi", ["wait", "1000"], chromeEnv);

      const countMutations = `() => new Promise((resolve) => {
        let count = 0;
        const observer = new MutationObserver((batch) => { count += batch.length; });
        observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(JSON.stringify({ mutations: count })); }, 1500);
      })`;

      const idle = evaluate(countMutations);
      assert.equal(
        idle.mutations,
        0,
        `an idle page mutated ${idle.mutations} times in 1.5s - the toolbar's self-triggered loop is back`,
      );

      // The same page must still write when state genuinely changes: zoom in and the
      // readout moves off 100%. A compare-before-write guard that swallowed real changes
      // would fail here.
      const zoom = evaluate(`() => new Promise((resolve) => {
        const bar = document.querySelector('[role=toolbar]');
        const buttons = [...bar.querySelectorAll('button')];
        const reset = buttons[1];
        const before = reset.textContent;
        buttons[2].click();
        setTimeout(() => resolve(JSON.stringify({ before, after: reset.textContent })), 600);
      })`);
      assert.equal(zoom.before, "100%");
      assert.notEqual(
        zoom.after,
        "100%",
        "zoom-in no longer reaches the readout - the write guard swallowed a real change",
      );

      // The zoom's own writes (the readout, the 400ms announce) land inside [data-luxe-ui]
      // and must not re-arm the loop: once they settle, the page is quiet again.
      run("chrome-devtools-axi", ["wait", "1000"], chromeEnv);
      const idleAgain = evaluate(countMutations);
      assert.equal(
        idleAgain.mutations,
        0,
        `the page kept mutating after a settled zoom (${idleAgain.mutations} in 1.5s)`,
      );
    } finally {
      await stopToolbarSession(session);
    }
  },
);
