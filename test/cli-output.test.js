import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AxiError } from "axi-sdk-js";

process.env.LUXE_HOST = "127.0.0.1";
process.env.LUXE_LINK_HOST = "127.0.0.1";

import {
  collapseHomeDirectory,
  copyCodeAssetsCommand,
  createDesignOutput,
  createExportOutput,
  createHomeOutput,
  createOpenOutput,
  createPollOutput,
  createPlaybookOutput,
  createServerSpawnOptions,
  createUserEndedOpenOutput,
  detectInvokingAgent,
  fetchJson,
  getCommandHelp,
  normalizeArgv,
  pollInterruptedText,
  pollWaitBannerText,
  pollWaitTickText,
  resolveServerEntry,
  saveDiagramCommand,
  shutdownServerOnPort,
  shouldForceRestartForLocalBuild,
  shouldKillProcessOnPort,
  shouldNarratePollWaitTicks,
  shouldOpenBrowser,
  shouldRestartServer,
  startPollWaitReporter,
  stopCommand,
  VERSION,
} from "../src/cli.js";
import { DESIGN_PRIORITY_RULE, DESIGN_SYSTEM_HINT } from "../src/design-reference.js";
import { LUXE_MERMAID_THEME_VARIABLES } from "../src/mermaid-theme.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

async function waitForPollListening(base, key, timeoutMs = 10_000) {
  const controller = new AbortController();
  const res = await fetch(`${base}/events/${key}`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const match = buffer.match(/^event: agent-presence\ndata: (.+)\n\n/m);
      if (match) {
        buffer = buffer.replace(match[0], "");
        if (JSON.parse(match[1]).state === "listening") return;
        continue;
      }
      const remaining = Math.max(1, deadline - Date.now());
      let timer;
      let value;
      let done;
      try {
        ({ value, done } = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out waiting for listening presence")), remaining);
          }),
        ]));
      } finally {
        clearTimeout(timer);
      }
      if (done) throw new Error("presence stream closed before listening");
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
}

function assertObservablePollWakePath(text) {
  assert.match(text, /Keep the poll in the foreground by default/i);
  assert.match(text, /return the feedback directly to the agent/i);
  assert.match(text, /harness-native tracked background-job facility/i);
  assert.match(text, /guaranteed to resume or notify the same agent/i);
  assert.match(text, /Never use `nohup`/);
  assert.match(text, /shell `&`/);
  assert.match(text, /`disown`/);
  assert.match(text, /redirected fire-and-forget processes/);
  assert.match(text, /detached terminal without an explicit verified callback/);
  assert.match(text, /no completion-aware background facility/i);
  assert.match(text, /verified wake callback into the surrounding supervisor/i);
  assert.match(text, /Do not tell the user the artifact is being monitored until that wake path is live/i);
  assert.doesNotMatch(text, /foreground command may run.*run the poll as a background task/i);
}

test("CLI version tracks package.json so release-please bumps reach the published binary", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, packageJson.version);
});

test("home output teaches agents when and how to use Luxe Editor", () => {
  const output = createHomeOutput({ bin: `${os.homedir()}/.local/bin/luxe`, sessions: [] });

  assert.equal(output.bin, "~/.local/bin/luxe");
  assert.match(output.description, /Luxe Editor/);
  assert.match(output.description, /complex response/);
  assert.match(output.description, /consider using Luxe Editor/);
  assert.match(output.description, /First generate an interactive HTML artifact/);
  assert.deepEqual(output.sessions, []);
  assert.equal("use_cases" in output, false);
  assert.equal("example_use_cases" in output, false);
  assert.equal("artifact_guidance" in output, false);
  assert.ok(output.visual_guidance.length <= 5);
  assert.ok(output.visual_guidance.some((item) => item.includes("visual hierarchy")));
  assert.ok(
    output.visual_guidance.some((item) => /screenshot/i.test(item) && /embed/i.test(item) && /prose/i.test(item)),
  );
  assert.ok(output.visual_guidance.some((item) => item.includes("sections, cards, tables")));
  assert.ok(output.visual_guidance.some((item) => item.includes("horizontal overflow")));
  assert.ok(output.visual_guidance.some((item) => item.includes("minmax(0, 1fr)")));
  assert.ok(output.visual_guidance.some((item) => /nested grid\/flex/i.test(item)));
  assert.ok(output.visual_guidance.some((item) => /pixel or monospace fonts/i.test(item)));
  assert.ok(!output.visual_guidance.some((item) => item.includes("test narrow viewports")));
  assert.ok(output.playbooks.some((item) => item.id === "diagram"));
  assert.equal(
    output.playbooks.find((item) => item.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.help.some((item) => item.includes("luxe <html-file>")));
  assert.ok(output.help.some((item) => item.includes("`.luxe/`")));
  assert.ok(output.help.some((item) => item.includes("luxe playbook <playbook_id>")));
  assert.ok(output.help.some((item) => item.includes("combines several playbooks")));
  assert.ok(output.help.some((item) => item.includes("MUST open each matching playbook")));
  assert.ok(output.help.some((item) => item.includes("reference other filesystem assets")));
  assert.ok(output.help.some((item) => item.includes("same directory as the HTML file")));
  assert.ok(output.help.includes(DESIGN_SYSTEM_HINT), "home help carries the single-sourced design rule verbatim");
  assert.ok(!output.help.some((item) => item.includes('<meta name="luxe-design" content="off">')));
  assert.ok(!output.help.some((item) => item.includes("Known IDs")));
  assert.ok(output.help.some((item) => item.includes("technical plan")));
});

test("the design-priority rule is single-sourced and keeps its three-step semantics", () => {
  // Keyword-level checks on the one owner constant; every surface that needs the rule
  // embeds DESIGN_PRIORITY_RULE, so wording changes happen here and nowhere else.
  assert.match(DESIGN_PRIORITY_RULE, /strict priority order/);
  assert.match(DESIGN_PRIORITY_RULE, /\(1\)[\s\S]*\(2\)[\s\S]*\(3\)/);
  assert.match(DESIGN_PRIORITY_RULE, /user asked for a specific look or named design system/);
  assert.match(DESIGN_PRIORITY_RULE, /project the artifact is about/);
  assert.match(DESIGN_PRIORITY_RULE, /current working directory/);
  assert.match(DESIGN_PRIORITY_RULE, /previews, proposes, or mocks/);
  assert.match(DESIGN_PRIORITY_RULE, /app's own design system/);
  assert.match(DESIGN_PRIORITY_RULE, /Tailwind CSS browser runtime v4 \+ DaisyUI v5/);
  assert.match(DESIGN_PRIORITY_RULE, /only when both steps come up empty/);
  assert.match(DESIGN_PRIORITY_RULE, /hand-writing styles/);
  assert.match(DESIGN_PRIORITY_RULE, /unless explicitly instructed/);
  assert.doesNotMatch(DESIGN_PRIORITY_RULE, /inspect the current project/i);

  assert.ok(DESIGN_SYSTEM_HINT.includes(DESIGN_PRIORITY_RULE), "the home/skill hint embeds the rule");
  assert.match(DESIGN_SYSTEM_HINT, /does not auto-inject/);
  assert.match(DESIGN_SYSTEM_HINT, /portable/);
  assert.match(DESIGN_SYSTEM_HINT, /luxe design/);
  assert.match(DESIGN_SYSTEM_HINT, /state which of the three design sources/);
});

test("home output warns agents that poll needs an observable wake path", () => {
  const output = createHomeOutput({ bin: "luxe", sessions: [] });
  const pollHelp = output.help.find((item) => item.includes("luxe poll <html-file>"));

  assert.ok(pollHelp, "home help mentions the poll command");
  assert.match(pollHelp, /long-poll/);
  assert.match(pollHelp, /stays silent/);
  assert.match(pollHelp, /never kill it/);
  assertObservablePollWakePath(pollHelp);
  assert.doesNotMatch(pollHelp, /Codex/);
  assert.match(pollHelp, /re-run/);
  assert.match(pollHelp, /queued feedback is never lost/);
  assert.match(pollHelp, /`Send & End` ends the session/);
  assert.match(pollHelp, /final feedback is still delivered once/);
  assert.doesNotMatch(pollHelp, /above 10 minutes/);
});

test("home output tailors poll guidance when invoked under Codex", () => {
  const output = createHomeOutput({ bin: "luxe", sessions: [], agent: "codex" });
  const pollHelp = output.help.find((item) => item.includes("luxe poll <html-file>"));

  assertObservablePollWakePath(pollHelp);
  assert.match(pollHelp, /Codex detected/);
  assert.match(pollHelp, /keep the poll attached to the active turn/);
});

test("home output keeps static skill poll guidance safe and agent-neutral", () => {
  const output = createHomeOutput({ bin: "luxe", sessions: [], agent: "static" });
  const pollHelp = output.help.find((item) => item.includes("luxe poll <html-file>"));

  assertObservablePollWakePath(pollHelp);
  assert.doesNotMatch(pollHelp, /keep the poll attached to the active turn/i);
  assert.doesNotMatch(pollHelp, /Codex detected/);
  assert.match(pollHelp, /queued feedback is never lost/);
});

test("invoking agent detection recognizes Codex runtime markers only", () => {
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_THREAD_ID: "thread" }), "codex");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_HOME: "/tmp/codex" }), "generic");
  assert.equal(detectInvokingAgent({ PATH: "/bin", CODEX_EXPERIMENTAL_FEATURE: "1" }), "generic");
  assert.equal(detectInvokingAgent({ PATH: "/bin" }), "generic");
});

test("top-level help renders static home output without dynamic sessions", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/luxe-help-test-`);
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/luxe.js", import.meta.url)), "--help"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, LUXE_STATE_DIR: stateDir },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /playbooks\[6\]/);
    assert.match(result.stdout, /luxe playbook <playbook_id>/);
    assert.match(result.stdout, /reference other filesystem assets/);
    assert.match(result.stdout, /same directory as the HTML file/);
    assert.match(result.stdout, /Tailwind CSS browser runtime v4/);
    assert.match(result.stdout, /luxe design/);
    assert.match(result.stdout, /strict priority order/);
    assert.match(result.stdout, /never kill it/);
    assert.match(result.stdout, /queued feedback is never lost/);
    assert.doesNotMatch(result.stdout, /above 10 minutes/);
    assert.doesNotMatch(result.stdout, /luxe-design/);
    assert.doesNotMatch(result.stdout, /sessions\[/);
    assert.doesNotMatch(result.stdout, /Known IDs/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("design output prints copy-pasteable CDN URLs so agents can opt in to DaisyUI", () => {
  const output = createDesignOutput();

  assert.match(output.playbook_router.instruction, /MUST open each matching playbook before writing HTML/);
  assert.equal(output.playbook_router.playbooks.length, 6);
  assert.equal(
    output.playbook_router.playbooks.find((playbook) => playbook.id === "diagram")?.use_when,
    "Map relationships, flows, state, and architecture",
  );
  assert.ok(output.design.summary.includes(DESIGN_PRIORITY_RULE), "design summary embeds the single-sourced rule");
  assert.match(output.design.summary, /does not auto-inject/);
  assert.match(output.design.summary, /^Use this .*fallback only if/i);
  assert.match(output.design.summary, /no design direction/i);
  assert.match(output.design.summary, /check first/i);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/daisyui@/);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/daisyui@.*\/themes\.css/);
  assert.match(output.design.cdn_snippet, /cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@/);
  // The three repairs that used to be an optional snippet are now injected by the
  // baseline, so the note points there instead of offering a second copy to paste.
  assert.equal(output.design.layout_safety_snippet, undefined);
  assert.match(output.design.layout_safety_note, /artifact baseline/);
  assert.match(output.design.layout_safety_note, /min-width on grid and flex children/);
  assert.match(
    output.design.cdn_urls.daisyui,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/daisyui@\d+\.\d+\.\d+\/daisyui\.css$/,
  );
  assert.match(
    output.design.cdn_urls.daisyuiThemes,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/daisyui@\d+\.\d+\.\d+\/themes\.css$/,
  );
  assert.match(
    output.design.cdn_urls.tailwind,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@\d+\.\d+\.\d+\/dist\/index\.global\.js$/,
  );
  assert.match(output.design.other_design_systems, /different design system|other design system/i);
  assert.match(output.diagram_tooling.use_when, /flows \/ architecture \/ state \/ sequence diagrams/);
  assert.match(output.diagram_tooling.use_when, /hand-built div\/flexbox boxes/);
  assert.match(output.diagram_tooling.mermaid_cdn_snippet, /cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+/);
  assert.match(output.diagram_tooling.mermaid_cdn_snippet, /mermaid\.initialize/);
  assert.match(
    output.diagram_tooling.cdn_urls.mermaid,
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.esm\.min\.mjs$/,
  );
  assert.equal(output.diagram_tooling.versions.mermaid, "11.15.0");
  assert.equal("opt_out" in output.design, false);
  assert.equal("rule" in output.design, false);
  assert.equal(output.design.latest_docs, "https://daisyui.com/components/");
  // D1: one theme block replaces the stock catalogue. Nothing may point an
  // agent at a DaisyUI theme any more.
  assert.equal("themes" in output, false);
  assert.match(output.luxe_theme_snippet, /data-theme="luxe"/);
  assert.match(output.luxe_theme_snippet, /--color-base-100: #ffffff/);
  assert.match(output.luxe_theme_snippet, /--color-primary: #463527/);
  assert.doesNotMatch(output.luxe_theme_snippet, /\bdark\b/i);
  assert.ok(output.components.actions.includes("button"));
  assert.ok(output.components.data_display.includes("card"));
  assert.ok(output.components.feedback.includes("alert"));
  assert.ok(output.reference.button.classes.includes("btn-primary"));
  assert.match(output.reference.modal.syntax, /<dialog/);
  assert.ok(output.reference.table.notes.some((item) => item.includes("overflow-x-auto")));
  assert.ok(output.reference.drawer.notes.some((item) => item.includes("drawer-toggle")));
  assert.ok(output.reference.mockup.notes.some((item) => item.includes("Keep `data-prefix` short")));
  assert.ok(output.reference.mockup.notes.some((item) => item.includes("line numbers")));
});

test("design output prescribes the one Luxe theme and warns against @apply on DaisyUI classes", () => {
  const output = createDesignOutput();

  assert.ok(output.theme_usage.some((item) => /exactly one theme and it is light/i.test(item)));
  assert.ok(output.theme_usage.some((item) => /Do not set `data-theme` to one of DaisyUI's stock themes/.test(item)));
  assert.ok(output.theme_usage.some((item) => item.includes("@apply") && /daisyui/i.test(item)));
  assert.ok(output.theme_usage.some((item) => /aborts the entire|no Tailwind styles/i.test(item)));
  // Done-criterion: no "dark" string literals survive in shipped guidance.
  for (const item of output.theme_usage) assert.doesNotMatch(item, /\bdark\b/i);
});

// UI-REVAMP 2.7's load-bearing rule has no chart component to live in, because
// this product ships none, so `luxe design` is where it reaches an author.
test("design output carries the chart palette and its labelling rule", () => {
  const output = createDesignOutput();

  assert.match(output.charts.labelling_rule, /direct labels, printed values, or an accompanying table view/);
  assert.match(output.charts.labelling_rule, /legend alone is not sufficient/i);
  assert.match(output.charts.labelling_rule, /below the 3:1 contrast floor/);
  assert.deepEqual(output.charts.palette, [
    "#5b85cc",
    "#874420",
    "#4bad8e",
    "#cf8b3b",
    "#677d12",
    "#be5b7f",
    "#73488e",
    "#9f4f36",
  ]);
  assert.ok(output.charts.palette_rules.some((rule) => /Fixed order, never cycled/.test(rule)));
  assert.ok(output.charts.palette_rules.some((rule) => /cap at four/.test(rule)));
  assert.equal(output.charts.sequential.length, 5);
  assert.equal(output.charts.diverging.length, 7);
});

// UI-REVAMP 2.9 mandates a bespoke Shiki theme. It is JSON handed to a third
// party, so it is serialized here rather than referenced as CSS variables.
test("design output ships the bespoke Luxe Shiki theme as usable JSON", () => {
  const output = createDesignOutput();
  const theme = JSON.parse(output.code_theme.shiki_theme_json);

  assert.equal(theme.name, "luxe");
  assert.equal(theme.type, "light");
  assert.equal(theme.colors["editor.background"], "#f7f4ec");
  assert.equal(theme.colors["diffEditor.insertedTextBackground"], "#e8f1dd");
  assert.equal(theme.colors["diffEditor.removedTextBackground"], "#f9e6e0");
  const foreground = (scope) => theme.tokenColors.find((entry) => entry.scope.includes(scope))?.settings.foreground;
  assert.equal(foreground("keyword"), "#963f8b");
  assert.equal(foreground("string"), "#4a7a2a");
  assert.equal(foreground("constant.numeric"), "#9a5b06");
  assert.equal(foreground("comment"), "#746b56");
  assert.equal(foreground("entity.name.function"), "#2f5e9e");
  assert.equal(foreground("entity.name.type"), "#b8511f");
  assert.equal(foreground("punctuation"), "#7a7466");
  assert.match(output.code_theme.note, /bespoke Shiki theme/);
});

test("playbook index output lists known playbooks with concise descriptions", () => {
  const output = createPlaybookOutput([]);

  assert.equal(output.playbooks.length, 6);
  assert.deepEqual(
    output.playbooks.map((playbook) => playbook.id),
    ["diagram", "table", "comparison", "plan", "code", "input"],
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "plan")?.use_when,
    "Explain a product or technical plan before implementation",
  );
  assert.equal(
    output.playbooks.find((playbook) => playbook.id === "input")?.use_when,
    "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
  );
  assert.ok(output.playbooks.every((playbook) => playbook.use_when.length > 20));
  assert.ok(output.help.some((item) => item.includes("luxe playbook <playbook_id>")));
  assert.ok(output.help.some((item) => item.includes("combines several playbooks")));
  assert.ok(output.help.some((item) => item.includes("MUST open each matching playbook")));
});

test("diagram playbook names the hand-built flow anti-pattern", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(output.playbook.choose.some((item) => item.includes("Mermaid")));
  assert.ok(output.playbook.pitfalls.some((item) => /hand-build boxes-and-arrows/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /div\/flexbox/i.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /does not auto-route edges/i.test(item)));
});

test("diagram playbook prescribes the Luxe themeVariables block, not a theme name", () => {
  const output = createPlaybookOutput(["diagram"]);

  assert.ok(
    output.playbook.design_rules.some((item) => /themeVariables/.test(item) && /luxe design/.test(item)),
    "diagram playbook must send agents to the Luxe Mermaid snippet and name the themeVariables block",
  );
  assert.ok(
    output.playbook.design_rules.some((item) => /annotation gold/i.test(item) && /never a node fill/i.test(item)),
    "the one accent stays reserved inside diagrams too",
  );
  assert.ok(
    output.playbook.design_rules.some((item) => /direct labels, printed values, or a table view/i.test(item)),
    "an artifact that diagrams often also charts; the labelling rule has to reach it",
  );
  assert.ok(output.playbook.pitfalls.some((item) => /without the Luxe `themeVariables` block/.test(item)));
  // No "dark" anywhere in shipped playbook guidance.
  for (const item of [...output.playbook.design_rules, ...output.playbook.pitfalls, ...output.playbook.choose]) {
    assert.doesNotMatch(item, /\bdark\b/i);
  }
});

test("code playbook points at the bespoke Luxe Shiki theme instead of a stock pair", () => {
  const output = createPlaybookOutput(["code"]);

  assert.ok(output.playbook.design_rules.some((item) => /code_theme\.shiki_theme_json/.test(item)));
  assert.ok(output.playbook.pitfalls.some((item) => /arbitrary stock Shiki theme/.test(item)));
  for (const item of [...output.playbook.design_rules, ...output.playbook.pitfalls]) {
    assert.doesNotMatch(item, /\bdark\b/i);
  }
});

// Light only. The whole page-background probe, the prefers-color-scheme
// listener, and the MutationObserver that kept diagrams in step with a theme
// that could flip are deleted rather than retuned, and the block that replaces
// them is imported from src/mermaid-theme.js rather than restated here.
test("the Mermaid snippet initializes once with the shared Luxe theme block", async () => {
  const output = createDesignOutput();
  const snippet = output.diagram_tooling.mermaid_cdn_snippet;

  assert.doesNotMatch(snippet, /prefers-color-scheme/);
  assert.doesNotMatch(snippet, /matchMedia/);
  assert.doesNotMatch(snippet, /MutationObserver/);
  assert.doesNotMatch(snippet, /\bdark\b/i);
  assert.match(snippet, /theme":\s*"base"/);
  assert.match(snippet, /themeVariables/);

  const body = snippet
    .replace(/^[\s\S]*?<script type="module">\n/, "")
    .replace(/\n<\/script>$/, "")
    .replace(/^\s*import mermaid from "[^"]+";\n/m, "");

  const initializedWith = [];
  const loggedRenderErrors = [];
  const runCalls = [];
  let nextRenderError;
  const diagram = { id: "d1" };
  const document = {
    readyState: "complete",
    querySelectorAll() {
      return [diagram];
    },
  };
  const window = {
    addEventListener() {
      assert.fail("a complete document must render immediately, with no load listener");
    },
  };
  const mermaid = {
    initialize(config) {
      initializedWith.push(config);
    },
    run(options) {
      runCalls.push(options);
      if (nextRenderError) {
        const error = nextRenderError;
        nextRenderError = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve();
    },
  };

  new Function("mermaid", "window", "document", "console", body)(mermaid, window, document, {
    error: (...args) => loggedRenderErrors.push(args),
  });
  await Promise.resolve();
  await Promise.resolve();

  // Initialized exactly once, and never re-initialized: nothing can flip.
  assert.equal(initializedWith.length, 1);
  assert.equal(initializedWith[0].theme, "base");
  assert.equal(initializedWith[0].securityLevel, "strict");
  assert.equal(initializedWith[0].startOnLoad, false);
  // The whole block reaches the page, values and all. What those values must be
  // is pinned against the tokens in design-tokens-derived.test.js; what matters
  // here is that the snippet serializes the shared object rather than a subset.
  assert.deepEqual(initializedWith[0].themeVariables, LUXE_MERMAID_THEME_VARIABLES);
  assert.deepEqual(runCalls, [{ nodes: [diagram] }]);
  assert.deepEqual(loggedRenderErrors, []);
});

test("a diagram that fails to render is logged, not thrown into the artifact", async () => {
  const body = createDesignOutput()
    .diagram_tooling.mermaid_cdn_snippet.replace(/^[\s\S]*?<script type="module">\n/, "")
    .replace(/\n<\/script>$/, "")
    .replace(/^\s*import mermaid from "[^"]+";\n/m, "");
  const loggedRenderErrors = [];
  const renderError = new Error("invalid Mermaid syntax");
  const mermaid = {
    initialize() {},
    run: () => Promise.reject(renderError),
  };

  new Function("mermaid", "window", "document", "console", body)(
    mermaid,
    { addEventListener() {} },
    {
      readyState: "complete",
      querySelectorAll: () => [{ id: "d1" }],
    },
    { error: (...args) => loggedRenderErrors.push(args) },
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(loggedRenderErrors, [["Mermaid diagram render failed:", renderError]]);
});

test("an artifact with no diagrams never calls into Mermaid at all", async () => {
  const body = createDesignOutput()
    .diagram_tooling.mermaid_cdn_snippet.replace(/^[\s\S]*?<script type="module">\n/, "")
    .replace(/\n<\/script>$/, "")
    .replace(/^\s*import mermaid from "[^"]+";\n/m, "");
  let ran = 0;

  new Function("mermaid", "window", "document", "console", body)(
    {
      initialize() {},
      run() {
        ran += 1;
        return Promise.resolve();
      },
    },
    { addEventListener() {} },
    { readyState: "complete", querySelectorAll: () => [] },
    console,
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ran, 0);
});

test("playbook detail output returns focused Luxe-native guidance", () => {
  const output = createPlaybookOutput(["input"]);

  assert.equal(output.playbook.id, "input");
  assert.match(output.playbook.use_when, /Must be used/);
  assert.match(output.playbook.use_when, /collect user input/);
  assert.ok(output.playbook.choose.some((item) => item.includes("control")));
  assert.ok(output.playbook.structure.some((item) => item.includes("decision")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queuePrompt")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("per-question form submit")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("radio change handlers")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-luxe-action")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("data-luxe-question")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("queueKey")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("human must confirm")));
  assert.ok(output.playbook.design_rules.some((item) => item.includes("Luxe conversation chrome")));
  assert.ok(!output.playbook.design_rules.some((item) => item.includes("sendQueuedPrompts")));
  assert.ok(output.playbook.luxe_notes.some((item) => item.includes("window.luxe.queuePrompt")));
  assert.ok(output.playbook.luxe_notes.some((item) => item.includes("onsubmit")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("unclear")));
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("radio change")));
  assert.ok(output.playbook.luxe_notes.some((item) => item.includes("Luxe")));
});

test("code playbook detail output requires a vendored and integrity-checked @pierre/diffs runtime", () => {
  const output = createPlaybookOutput(["code"]);
  const guidance = output.playbook.design_rules.join("\n");

  assert.equal(output.playbook.id, "code");
  assert.match(output.playbook.use_when, /source code/);
  assert.ok(output.playbook.choose.some((item) => item.includes("FileDiff")));
  assert.ok(output.playbook.choose.some((item) => item.includes("split") && item.includes("unified")));
  assert.match(guidance, /@pierre\/diffs/);
  assert.match(guidance, /luxe copy-code-assets <html-file>/);
  assert.match(guidance, /\.\/luxe-pierre-diffs-1\.2\.10\.iife\.js/);
  assert.match(guidance, /window\.LuxePierreDiffs/);
  assert.doesNotMatch(guidance, /https:\/\/esm\.sh\//);
  assert.doesNotMatch(guidance, /<script[^>]+integrity=/, "local file scripts with SRI are blocked by Chrome");
  assert.match(guidance, /new FileDiff/);
  assert.match(guidance, /Shiki theme/);
  assert.ok(output.playbook.pitfalls.some((item) => item.includes("<pre>")));
});

test("copy-code-assets copies only the exact vendored browser bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "luxe-code-assets-"));
  const artifact = path.join(root, "review.html");
  await writeFile(artifact, "<!doctype html><title>Review</title>");
  try {
    const copied = await copyCodeAssetsCommand([artifact]);
    const asset = copied.code_asset.file;
    const source = await readFile(new URL("../dist/design/luxe-pierre-diffs-1.2.10.iife.js", import.meta.url));

    assert.equal(path.basename(asset), "luxe-pierre-diffs-1.2.10.iife.js");
    assert.equal(
      copied.code_asset.integrity,
      "sha384-a+ZFSdkJRm+4ntEDkfHEKS7F7ieHOjDBNII6pSTGZJloXyIndr18DRd7FyBoIKuT",
    );
    assert.deepEqual(await readFile(asset), source);

    await writeFile(asset, "window.LuxePierreDiffs = {};\n");
    await assert.rejects(() => copyCodeAssetsCommand([artifact]), /Refusing to overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan playbook detail output has polished guidance copy", () => {
  const output = createPlaybookOutput(["plan"]);

  assert.ok(output.playbook.structure.some((item) => item.includes("Then describe a proposed approach")));
  assert.ok(output.playbook.structure.every((item) => !item.includes("Then describe the a proposed approach")));
});

test("unknown playbook ids produce an actionable validation error", () => {
  assert.throws(
    () => createPlaybookOutput(["unknown"]),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.message, /Unknown playbook/);
      assert.ok(error.suggestions.some((item) => item.includes("luxe playbook")));
      return true;
    },
  );
});

test("home directory collapse tolerates Windows mixed separators", () => {
  assert.equal(
    collapseHomeDirectory("C:\\Users\\runneradmin/.local/bin/luxe", "C:\\Users\\runneradmin"),
    "~/.local/bin/luxe",
  );
  assert.equal(
    collapseHomeDirectory("C:\\Users\\runneradmin\\.local\\bin\\luxe", "C:\\Users\\runneradmin"),
    "~/.local/bin/luxe",
  );
});

test("open output keeps the user URL in session data and next_step focused on polling", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.url, "http://localhost:4387/session/abc123");
  assert.equal(output.session.status, "opened");
  // Keyword-level lock on the load-bearing semantics of this agent-facing string:
  // poll now (not the user-facing URL), never kill the poll, no --timeout-ms, and the
  // reopen etiquette. Sentence-level phrasing is free to change without touching this test.
  assert.doesNotMatch(output.next_step, /Tell the user (?:to open|to visit)/i);
  assert.doesNotMatch(output.next_step, /http:\/\/localhost:4387\/session\/abc123/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.match(output.next_step, /luxe poll \/tmp\/artifact\.html/);
  assert.match(output.next_step, /layout_warnings/);
  assert.match(output.next_step, /never kill it/);
  assertObservablePollWakePath(output.next_step);
  assert.doesNotMatch(output.next_step, /Codex/);
  assert.match(output.next_step, /queued feedback is never lost/);
  assert.match(output.next_step, /Do not pass --timeout-ms/);
  assert.match(output.next_step, /If the user ends the session, stop polling and do not reopen it/);
  assert.match(output.next_step, /--reopen/);
});

test("open output gives Codex the shared wake-path contract plus an attached-turn warning", () => {
  const output = createOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
    status: "opened",
    agent: "codex",
  });

  assertObservablePollWakePath(output.next_step);
  assert.match(output.next_step, /Codex detected/);
  assert.match(output.next_step, /keep the poll attached to the active turn/);
});

test("a user-ended open refuses with a status agents can branch on, not a URL to open", () => {
  const output = createUserEndedOpenOutput({
    file: "/tmp/artifact.html",
    url: "http://localhost:4387/session/abc123",
  });

  assert.equal(output.session.file, "/tmp/artifact.html");
  assert.equal(output.session.status, "user-ended");
  assert.match(output.next_step, /user explicitly ended this Luxe Editor session from the browser/);
  assert.match(output.next_step, /did not reopen it/);
  assert.match(output.next_step, /Do not reopen unless the user asks for further review/);
  assert.match(output.next_step, /luxe \/tmp\/artifact\.html --reopen/);
});

test("export output reports the written file and reassures it needs no server", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [],
  });

  assert.equal(output.export.source, "/tmp/report.html");
  assert.equal(output.export.output, "/tmp/report.export.html");
  assert.equal(output.export.unresolved_local_assets, 0);
  assert.equal(output.export.bytes, Buffer.byteLength("<html></html>"));
  assert.match(output.next_step, /no Luxe server/);
  assert.match(output.next_step, /remote CDN\/font references are left as links/);
});

test("export output surfaces local assets that could not be inlined", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [{ kind: "load-failed", ref: "./missing.png" }],
  });

  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png" }]);
  assert.match(output.next_step, /LOCAL assets could not be inlined/);
});

test("export output counts active srcdoc refs as unresolved assets", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [{ kind: "srcdoc-resource", ref: "local.png" }],
  });

  assert.equal(output.export.unresolved_local_assets, 1);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "srcdoc-resource", ref: "local.png" }]);
  assert.equal("notices" in output, false);
});

test("export output separates unresolved assets from notices", () => {
  const output = createExportOutput({
    source: "/tmp/report.html",
    output: "/tmp/report.export.html",
    html: "<html></html>",
    warnings: [
      { kind: "load-failed", ref: "./missing.png", reason: "ENOENT" },
      { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
      { kind: "csp-meta", ref: "script-src 'self'" },
    ],
  });

  assert.equal(output.export.unresolved_local_assets, 1);
  assert.equal(output.export.notices, 2);
  assert.deepEqual(output.unresolved_local_assets, [{ kind: "load-failed", ref: "./missing.png", reason: "ENOENT" }]);
  assert.deepEqual(output.notices, [
    { kind: "file-url-redacted", ref: "file:///Users/kun/secret.png" },
    { kind: "csp-meta", ref: "script-src 'self'" },
  ]);
  assert.equal(output.warnings.length, 3);
});

test("export command writes a portable HTML file next to the artifact", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/luxe-export-test-`);
  const artifact = `${dir}/report.html`;
  await writeFile(`${dir}/theme.css`, ".btn{color:rebeccapurple}", "utf8");
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="theme.css">' +
      '<link rel="stylesheet" href="https://cdn.example/app.css"></head><body><h1>Hi</h1></body></html>',
    "utf8",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/luxe.js", import.meta.url)), "export", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LUXE_STATE_DIR: dir },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /report\.export\.html/);
    const exported = await readFile(`${dir}/report.export.html`, "utf8");
    // local stylesheet inlined; remote stylesheet left as a link; SDK stripped
    assert.match(exported, /<style>\.btn\{color:rebeccapurple\}<\/style>/);
    assert.match(exported, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
    assert.doesNotMatch(exported, /sdk\.js/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("export command treats --out value as an option operand, not the source file", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/luxe-export-test-`);
  const artifact = `${dir}/report.html`;
  const output = `${dir}/custom.html`;
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/luxe.js", import.meta.url)), "export", "--out", output, artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LUXE_STATE_DIR: dir },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /custom\.html/);
    assert.match(await readFile(output, "utf8"), /<h1>Hi<\/h1>/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("poll help requires an observable wake path", () => {
  const help = getCommandHelp("poll");

  assert.match(help, /long-polls indefinitely/);
  assert.match(help, /stays silent/);
  assert.match(help, /never kill it/);
  assertObservablePollWakePath(help);
  assert.doesNotMatch(help, /Codex/);
  assert.match(help, /queued feedback is never lost/);
  assert.match(help, /Do not pass --timeout-ms/);
  assert.match(help, /tests and debugging only/);
  assert.match(help, /`Send & End` ends the session/);
  assert.match(help, /final feedback is still delivered once/);
  assert.doesNotMatch(help, /above 10 minutes/);
});

test("server help requires exact remote opt-in and distinguishes it from allowed hosts", () => {
  const help = getCommandHelp("server");
  assert.match(help, /LUXE_ALLOW_REMOTE=1/);
  assert.match(help, /required.*non-loopback|non-loopback.*required/i);
  assert.match(help, /LUXE_ALLOWED_HOSTS.*does not satisfy|does not satisfy.*LUXE_ALLOWED_HOSTS/i);
});

test("poll help is Codex-aware when requested", () => {
  const help = getCommandHelp("poll", { agent: "codex" });

  assertObservablePollWakePath(help);
  assert.match(help, /Codex detected/);
  assert.match(help, /keep the poll attached to the active turn/);
});

test("feedback next step keeps the next poll completion observable", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
  });

  assert.equal("layout_warnings" in output, false);
  assert.match(output.next_step, /never kill it/);
  assert.match(output.next_step, /without --timeout-ms/);
  assertObservablePollWakePath(output.next_step);
  assert.doesNotMatch(output.next_step, /Codex/);
  assert.match(output.next_step, /queued feedback is never lost/);
  assert.match(output.next_step, /Do not respond to the user just yet\. Now you must run/);
  assert.match(output.next_step, /fresh layout_warnings/);
  assert.doesNotMatch(output.next_step, /above 10 minutes/);
});

test("feedback next step is Codex-aware when requested", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "feedback", dom_snapshot: "", prompts: [] },
    agent: "codex",
  });

  assertObservablePollWakePath(output.next_step);
  assert.match(output.next_step, /Codex detected/);
  assert.match(output.next_step, /keep the poll attached to the active turn/);
});

test("layout warning feedback identifies a report that agents must verify before repair", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          axis: "horizontal",
          overflowPx: 16,
          severity: "error",
        },
      ],
    },
  });

  assert.ok("layout_warnings" in output);
  assert.equal(output.layout_warnings.length, 1);
  assert.match(output.next_step, /1 reported warning/);
  assert.match(output.next_step, /verify each reported locator in the browser before repairing/i);
  assert.match(output.next_step, /before involving the human/);
  assert.doesNotMatch(output.next_step, /\bproven\b|browser found/i);
  assert.doesNotMatch(output.next_step, /reload or re-open/);
});

test("whiteboard feedback tells agents to read the summary, inspect files when needed, and update the Mermaid source", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [
        {
          uid: "",
          prompt: "Whiteboard edits to diagram 1:\nMoved rectangle (Auth)",
          selector: "",
          tag: "whiteboard",
          text: "Whiteboard: diagram 1",
          target: {
            type: "excalidraw-scene",
            diagramIndex: 0,
            diagramId: "mermaid-1",
            sourceHash: "abc",
            scenePath: "/state/whiteboards/k/0.excalidraw",
            previewPath: "/state/whiteboards/k/0.png",
            imageFallback: false,
            stats: { added: 0, removed: 0, moved: 1, relabeled: 0, drawn: 0 },
          },
        },
      ],
    },
  });

  assert.match(output.next_step, /whiteboard edits \(tag "whiteboard"\)/);
  assert.match(output.next_step, /read the edit summary in the prompt text first/);
  assert.match(output.next_step, /scenePath/);
  assert.match(output.next_step, /previewPath/);
  assert.match(output.next_step, /Mermaid source stays authoritative/);
  assert.match(output.next_step, /never try to write the \.excalidraw scene back/);
});

test("non-whiteboard feedback does not mention whiteboard guidance", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Tighten this", selector: "h1", tag: "h1", text: "Title" }],
    },
  });

  assert.doesNotMatch(output.next_step, /whiteboard/i);
});

test("a poll reporting the session ended by the user tells the agent to stop and not reopen", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "ended", ended_by: "user" },
  });

  assert.equal(output.session.status, "ended");
  assert.equal(output.session.ended_by, "user");
  assert.match(output.next_step, /user ended this Luxe Editor session/);
  assert.match(output.next_step, /Stop polling/);
  assert.match(output.next_step, /do not run `luxe \/tmp\/report\.html` to reopen it/);
  assert.match(output.next_step, /deliver any remaining updates directly in this conversation/i);
  assert.match(output.next_step, /luxe \/tmp\/report\.html --reopen/);
});

test("a poll reporting an agent-ended session allows a plain reopen if still needed", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "ended", ended_by: "agent" },
  });

  assert.equal(output.session.ended_by, "agent");
  assert.match(output.next_step, /Stop polling/);
  assert.match(output.next_step, /luxe \/tmp\/report\.html`\s+to open a fresh session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
});

test("the final feedback batch before a user end flags session_ended and skips the reopen instruction", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "bye" }],
      session_ended: true,
      ended_by: "user",
    },
  });

  assert.equal(output.session.session_ended, true);
  assert.equal(output.session.ended_by, "user");
  assert.match(output.next_step, /last feedback before the user ended the session/);
  assert.match(output.next_step, /Stop polling \/tmp\/report\.html and do not reopen it/);
  assert.match(output.next_step, /luxe \/tmp\/report\.html --reopen/);
  assert.doesNotMatch(output.next_step, /reload or re-open/);
});

test("the final feedback batch before an agent end preserves ended_by and allows plain reopen", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "bye" }],
      session_ended: true,
      ended_by: "agent",
    },
  });

  assert.equal(output.session.session_ended, true);
  assert.equal(output.session.ended_by, "agent");
  assert.match(output.next_step, /last feedback before the Luxe Editor session ended/);
  assert.match(output.next_step, /luxe \/tmp\/report\.html`\s+to open a fresh session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
  assert.doesNotMatch(output.next_step, /user ended this Luxe Editor session/);
});

test("final user-ended feedback still requires severe layout repair without reopening", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      prompts: [],
      layout_warnings: [
        { selector: "button", kind: "clipped-control", axis: "horizontal", overflowPx: 1, severity: "error" },
      ],
      session_ended: true,
      ended_by: "user",
    },
  });

  assert.match(output.next_step, /Verify each reported locator in the browser before repairing/);
  assert.match(output.next_step, /open the artifact directly at the affected viewport/);
  assert.match(output.next_step, /without reopening this ended Luxe session/);
  assert.doesNotMatch(output.next_step, /--reopen/);
});

test("final agent-ended feedback requires repair in a fresh audit session", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      prompts: [],
      layout_warnings: [
        { selector: "button", kind: "clipped-control", axis: "horizontal", overflowPx: 1, severity: "error" },
      ],
      session_ended: true,
      ended_by: "agent",
    },
  });

  assert.match(output.next_step, /Verify each reported locator in the browser before repairing/);
  assert.match(output.next_step, /open a fresh session and re-check the audit/);
});

test("persistent severe layout failures still require repair before review", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          axis: "horizontal",
          overflowPx: 120,
          viewportWidth: 390,
          severity: "error",
          persistent: true,
        },
      ],
    },
  });

  assert.match(output.next_step, /reported warning/);
  assert.match(output.next_step, /before involving the human/);
  assert.doesNotMatch(output.next_step, /fine to proceed/);
});

test("warning-only layout observations are omitted from poll output", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: ".accent",
          kind: "element-parent-overflow",
          overflowPx: 20,
          viewportWidth: 720,
          severity: "warning",
          persistent: false,
        },
        {
          selector: ".unproven",
          kind: "clipped-text",
          overflowPx: 200,
          viewportWidth: 720,
          persistent: false,
        },
      ],
    },
  });

  assert.equal("layout_warnings" in output, false);
  assert.doesNotMatch(output.next_step, /layout warning/);
});

test("a mix of fresh and persistent severe failures still mandates a fix pass", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: {
      status: "feedback",
      dom_snapshot: "",
      prompts: [],
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          axis: "horizontal",
          overflowPx: 16,
          viewportWidth: 720,
          severity: "error",
          persistent: false,
        },
        {
          selector: "span#badge",
          kind: "clipped-text",
          axis: "horizontal",
          overflowPx: 12,
          viewportWidth: 720,
          severity: "error",
          persistent: true,
        },
      ],
    },
  });

  assert.match(output.next_step, /2 reported warnings/);
  assert.match(output.next_step, /Verify each reported locator/);
  assert.match(output.next_step, /before involving the human/);
});

test("poll wait messages tell watching agents the silence is normal", () => {
  const banner = pollWaitBannerText("/tmp/report.html");
  assert.match(banner, /\[luxe\]/);
  assert.match(banner, /Long-polling for user feedback/);
  assert.match(banner, /stays silent/);
  assert.match(banner, /leave it running/i);
  assert.match(banner, /queued feedback is never lost/);

  const tick = pollWaitTickText(3 * 60_000);
  assert.match(tick, /\[luxe\]/);
  assert.match(tick, /Still waiting for user feedback \(3m\)/);
  assert.match(tick, /leave this running/i);

  const interrupted = pollInterruptedText("/tmp/report.html");
  assert.match(interrupted, /\[luxe\]/);
  assert.match(interrupted, /Poll interrupted/);
  assert.match(interrupted, /user may still be reviewing/);
  assert.match(interrupted, /luxe poll \/tmp\/report\.html/);
  assert.match(interrupted, /queued feedback is never lost/);
});

test("poll wait reporter writes a banner immediately and heartbeats on an interval", async () => {
  const lines = [];
  const reporter = startPollWaitReporter({
    file: "/tmp/report.html",
    write: (line) => {
      lines.push(line);
    },
    intervalMs: 5,
  });

  try {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Long-polling for user feedback/);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(lines.length >= 2, "emits heartbeat lines while waiting");
    assert.match(lines[1], /Still waiting for user feedback/);
  } finally {
    reporter.stop();
  }

  const countAfterStop = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lines.length, countAfterStop, "stops heartbeating after stop()");
});

test("poll wait reporter still banners without ticks when narration is off", async () => {
  const lines = [];
  const reporter = startPollWaitReporter({
    file: "/tmp/report.html",
    write: (line) => {
      lines.push(line);
    },
    intervalMs: 5,
    narrateTicks: false,
  });

  try {
    assert.equal(lines.length, 1, "the one-shot not-hung banner is unconditional");
    assert.match(lines[0], /Long-polling for user feedback/);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(lines.length, 1, "suppresses the recurring heartbeat lines");
  } finally {
    reporter.stop();
  }
});

test("shouldNarratePollWaitTicks heartbeats only in an interactive terminal", () => {
  assert.equal(shouldNarratePollWaitTicks({ isTTY: true }), true);
  assert.equal(shouldNarratePollWaitTicks({ isTTY: undefined }), false);
  assert.equal(shouldNarratePollWaitTicks({ isTTY: false }), false);
});

test("spawned poll with piped stderr banners once and leaves re-run guidance when killed", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/luxe-poll-wait-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const server = await serve({ port: 0, stateFile: `${stateDir}/state.json`, version: VERSION });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(sessionResponse.ok, "session opens");

    const key = sessionKey(await canonicalFile(artifact));

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/luxe.js", import.meta.url)), "poll", artifact],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LUXE_STATE_DIR: stateDir, LUXE_PORT: String(server.port) },
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await waitForPollListening(base, key);
    assert.equal(
      stderr.match(/Long-polling for user feedback/g)?.length,
      1,
      "piped stderr still gets the one-shot not-hung banner",
    );
    assert.doesNotMatch(stderr, /Still waiting for user feedback/, "the banner carries no immediate wait tick");

    // Wait for "close" rather than "exit": "exit" can fire while the final stderr chunk is
    // still in flight, so asserting on stderr at "exit" races the guidance message.
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    await closed;

    // Windows terminates Node child processes directly instead of delivering SIGTERM
    // to the child process's JavaScript signal handler.
    if (process.platform !== "win32") {
      assert.match(stderr, /Poll interrupted/);
      assert.match(stderr, /queued feedback is never lost/);
    }
  } finally {
    await server.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

// Regression net for the D2 same-origin guard on /api/:key/agent-reply. The CLI posts it from
// Node, which sends neither Origin nor Referer, so a guard that fails closed on missing
// provenance would 403 here and silently drop every agent reply. Exercised through the real
// binary rather than the module, because the header behavior belongs to the HTTP client.
test("spawned poll delivers --agent-reply through the guarded route", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/luxe-agent-reply-test-`);
  const artifact = `${stateDir}/artifact.html`;
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const server = await serve({ port: 0, stateFile: `${stateDir}/state.json`, version: VERSION });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(sessionResponse.ok, "session opens");
    const key = sessionKey(await canonicalFile(artifact));

    // spawn, never spawnSync: the server under test runs in this process, so a synchronous
    // spawn would block the event loop that has to answer the child's requests.
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/luxe.js", import.meta.url)),
        "poll",
        "--agent-reply",
        "Built the summary, start with the risks table",
        "--timeout-ms",
        "500",
        artifact,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, LUXE_STATE_DIR: stateDir, LUXE_PORT: String(server.port) },
      },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));

    assert.equal(exit, 0, `${stderr}${stdout}`);
    // The reply reached the session: the chrome bootstrap replays it as initial chat.
    const chrome = await fetch(`${base}/session/${key}`).then((res) => res.text());
    assert.match(chrome, /Built the summary, start with the risks table/);
  } finally {
    await server.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test("waiting next step reassures agents that re-running poll loses nothing", () => {
  const output = createPollOutput({
    file: "/tmp/report.html",
    response: { status: "waiting" },
  });

  assert.match(output.next_step, /luxe poll \/tmp\/report\.html/);
  assert.match(output.next_step, /without --timeout-ms/);
  assert.match(output.next_step, /queued feedback is never lost/);
});

test("html file arguments normalize to the hidden open command", () => {
  assert.deepEqual(normalizeArgv(["report.html"]), ["open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-open", "report.html"]), ["open", "--no-open", "report.html"]);
  assert.deepEqual(normalizeArgv(["--no-gate", "report.html"]), ["open", "--no-gate", "report.html"]);
  assert.deepEqual(normalizeArgv(["poll", "report.html"]), ["poll", "report.html"]);
  // `setup` was removed with D10; it is no longer a command, so it falls through to open.
  assert.deepEqual(normalizeArgv(["setup", "hooks"]), ["open", "setup", "hooks"]);
  assert.deepEqual(normalizeArgv(["playbook", "diagram"]), ["playbook", "diagram"]);
  assert.deepEqual(normalizeArgv(["design"]), ["design"]);
  assert.deepEqual(normalizeArgv(["--help"]), ["--help"]);
});

test("SDK reserved commands pass through instead of normalizing to open", () => {
  assert.deepEqual(normalizeArgv(["update"]), ["update"]);
  assert.deepEqual(normalizeArgv(["update", "--check"]), ["update", "--check"]);
  assert.deepEqual(normalizeArgv(["update", "--help"]), ["update", "--help"]);
});

test("server spawn options detach without inheriting invalid streams", () => {
  const options = createServerSpawnOptions();

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
});

test("server spawn options can persist detached server output to a log fd", () => {
  const options = createServerSpawnOptions(17);

  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", 17, 17]);
});

test("server CLI refuses a non-loopback LUXE_HOST without the exact opt-in", async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/luxe-remote-refusal-test-`);
  try {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, LUXE_HOST: "0.0.0.0", LUXE_STATE_DIR: stateDir };
    delete env.LUXE_ALLOW_REMOTE;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/luxe.js", import.meta.url)), "server", "--port", "0"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));

    assert.equal(exit, 1);
    assert.match(output, /LUXE_ALLOW_REMOTE=1/);
    assert.match(output, /code: SERVER_ERROR/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("server entry resolves to a node-executable script that actually invokes run()", () => {
  // Running from source, the entry must be `bin/luxe.js` (the only file in the
  // source tree that calls run() on import). In the published bundle only `dist/cli.mjs`
  // ships - it embeds the bin wrapper so it self-invokes. Either way, spawning the entry
  // with `node <entry> server` must boot the server, not silently load the module and exit.
  const entry = resolveServerEntry();
  assert.ok(existsSync(entry), `server entry must exist on disk, got: ${entry}`);
  // From source: bin/luxe.js is present and preferred.
  assert.equal(entry, fileURLToPath(new URL("../bin/luxe.js", import.meta.url)));
});

test("local built CLI opens force a server restart while source and installed runs do not", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));

  assert.equal(shouldForceRestartForLocalBuild(`${root}/dist/cli.mjs`, true), true);
  assert.equal(shouldForceRestartForLocalBuild(`${root}/bin/luxe.js`, true), false);
  assert.equal(shouldForceRestartForLocalBuild("/usr/local/lib/node_modules/editeur-luxe/dist/cli.mjs", false), false);
});

test("shouldRestartServer reuses a server running the same version", () => {
  assert.equal(shouldRestartServer("0.1.4", { ok: true, version: "0.1.4" }), false);
});

test("shouldRestartServer restarts same-version Luxe servers when forced", () => {
  assert.equal(shouldRestartServer("0.1.4", { ok: true, app: "luxe", version: "0.1.4" }, true), true);
  assert.equal(shouldRestartServer("0.1.4", { ok: true, app: "other", version: "0.1.4" }, true), false);
});

test("shouldRestartServer restarts when the running server reports a different version", () => {
  // Catches the upgrade scenario: client got bumped to 0.1.4 but a 0.1.3 server is still
  // holding the port from a previous invocation.
  assert.equal(shouldRestartServer("0.1.4", { ok: true, version: "0.1.3" }), true);
});

test("shouldRestartServer restarts when the running server predates the version handshake", () => {
  // Pre-handshake servers (any release older than this change) return `{ ok: true }` with
  // no version field. Treat that as "older than me" and restart so users actually get the
  // version they just installed.
  assert.equal(shouldRestartServer("0.1.4", { ok: true }), true);
});

test("shouldRestartServer does not restart when /health was unreachable", () => {
  // null = fetch failed; the caller should fall through to startServer instead of trying
  // to POST /shutdown against nothing.
  assert.equal(shouldRestartServer("0.1.4", null), false);
});

test("shouldKillProcessOnPort does not kill unidentified health responders", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "other", version: "0.1.3" }), false);
});

test("shouldKillProcessOnPort kills pre-handshake Luxe servers after shutdown fails", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true }), true);
});

test("shouldKillProcessOnPort only kills Luxe servers with a mismatched version", () => {
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "luxe", version: "0.1.3" }), true);
  assert.equal(shouldKillProcessOnPort("0.1.4", { ok: true, app: "luxe", version: "0.1.4" }), false);
});

test("shutdownServerOnPort kills pre-handshake Luxe servers when shutdown does not free the port", async () => {
  let shutdowns = 0;
  let kills = 0;
  const portFreeResults = [false, true];

  const output = await shutdownServerOnPort(4387, {
    baseUrl: "http://127.0.0.1:4387",
    currentVersion: "0.1.4",
    fetchHealth: async () => ({ ok: true }),
    requestShutdown: async () => {
      shutdowns += 1;
    },
    waitForPortFree: async () => portFreeResults.shift() ?? false,
    killProcessOnPort: () => {
      kills += 1;
    },
    processMatchesLuxe: () => true,
  });

  assert.equal(shutdowns, 1);
  assert.equal(kills, 1);
  assert.deepEqual(output, { server: { status: "stopped", port: 4387 } });
});

test("shutdownServerOnPort ignores unidentified health responders", async () => {
  let shutdowns = 0;
  let kills = 0;

  const output = await shutdownServerOnPort(4387, {
    baseUrl: "http://127.0.0.1:4387",
    currentVersion: "0.1.4",
    fetchHealth: async () => ({ ok: true }),
    requestShutdown: async () => {
      shutdowns += 1;
    },
    waitForPortFree: async () => false,
    killProcessOnPort: () => {
      kills += 1;
    },
    processMatchesLuxe: () => false,
  });

  assert.equal(shutdowns, 0);
  assert.equal(kills, 0);
  assert.deepEqual(output, { server: { status: "not-luxe", port: 4387 } });
});

test("open can resume a session without opening another browser window", () => {
  assert.equal(shouldOpenBrowser(["--no-open", "artifact.html"], {}), false);
  assert.equal(shouldOpenBrowser(["artifact.html", "--no-open"], {}), false);
  assert.equal(shouldOpenBrowser(["--no-gate", "artifact.html"], {}), true);
  assert.equal(shouldOpenBrowser(["artifact.html"], { LUXE_NO_OPEN: "1" }), false);
  assert.equal(shouldOpenBrowser(["artifact.html"], {}), true);
  assert.match(getCommandHelp("open"), /--no-open/);
  assert.match(getCommandHelp("open"), /--no-gate/);
  assert.match(getCommandHelp("open"), /--reopen/);
  assert.match(getCommandHelp("playbook"), /diagram/);
  assert.match(getCommandHelp("playbook"), /code/);
  assert.match(getCommandHelp("playbook"), /input/);
  assert.doesNotMatch(getCommandHelp("playbook"), new RegExp(`${"di"}ff, input`));
  assert.doesNotMatch(getCommandHelp("playbook"), /interactive/);
  assert.match(getCommandHelp("design"), /DaisyUI/);
  assert.match(getCommandHelp("design"), /luxe design/);
  assert.match(getCommandHelp("design"), /portable/);
  assert.ok(getCommandHelp("design").includes(DESIGN_PRIORITY_RULE), "design help embeds the single-sourced rule");
  assert.match(getCommandHelp("design"), /fallback, not the default/i);
  assert.match(getCommandHelp("design"), /inspect the subject project/i);
  assert.doesNotMatch(getCommandHelp("design"), /auto-injects/);
});

test("polling a file without an active session tells the agent to open it first", () => {
  assert.throws(
    () => createPollOutput({ file: "/tmp/report.html", response: { status: "missing" } }),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "NOT_FOUND");
      assert.match(error.message, /No active Luxe Editor session/);
      assert.ok(error.suggestions.some((item) => item.includes("luxe /tmp/report.html")));
      return true;
    },
  );
});

test("network fetch failures become structured Luxe server errors", async () => {
  await assert.rejects(
    () => fetchJson("http://127.0.0.1:1/api/poll"),
    (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "SERVER_ERROR");
      assert.match(error.message, /Luxe Editor server connection failed/);
      assert.ok(error.suggestions.some((item) => item.includes("luxe server --verbose")));
      return true;
    },
  );
});

test("fetchJson retries transient connection failures", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      req.socket.destroy();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "waiting" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const port = address.port;
    const result = await fetchJson(`http://127.0.0.1:${port}/api/poll`, { retries: 1, retryDelayMs: 1 });

    assert.deepEqual(result, { status: "waiting" });
    assert.equal(requests, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchJson reports interrupted response body failures without retrying", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
    const port = address.port;

    await assert.rejects(
      () => fetchJson(`http://127.0.0.1:${port}/api/poll`, { retries: 1, retryDelayMs: 1 }),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "SERVER_ERROR");
        assert.match(error.message, /Luxe Editor poll response was interrupted/);
        return true;
      },
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("stop command shuts down the running server on the configured port", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/luxe-stop-test-`);
  const server = await serve({ port: 0, stateFile: `${dir}/state.json`, version: "9.9.9-test" });
  try {
    const output = await stopCommand(["--port", String(server.port)]);
    assert.deepEqual(output, { server: { status: "stopped", port: server.port } });
    await server.done;
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    await server.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("stop command reports when no server is running", async () => {
  const dir = await mkdtemp(`${os.tmpdir()}/luxe-stop-test-`);
  try {
    // Bind then release a port so we know nothing is listening on it.
    const probe = await serve({ port: 0, stateFile: `${dir}/state.json` });
    const freePort = probe.port;
    await probe.close();

    const output = await stopCommand(["--port", String(freePort)]);
    assert.deepEqual(output, { server: { status: "not-running", port: freePort } });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The agent-facing half of "Save to machine" (D5). It works directly on the
// sidecar, deliberately: the browser control's route is same-origin guarded,
// which is right for a browser control and wrong for a header-less CLI.
// ---------------------------------------------------------------------------
async function withSaveDiagramFixture(run) {
  const dir = await mkdtemp(`${os.tmpdir()}/luxe-save-diagram-`);
  const previousStateDir = process.env.LUXE_STATE_DIR;
  const state = `${dir}/state`;
  process.env.LUXE_STATE_DIR = state;
  const artifact = `${dir}/report.html`;
  await writeFile(artifact, '<!doctype html><html><body><pre class="mermaid">flowchart TD\n A-->B</pre></body></html>');
  const store = await import("../src/whiteboard-store.js");
  const key = sessionKey(await canonicalFile(artifact));
  try {
    await run({ dir, state, artifact, key, store, realArtifact: await canonicalFile(artifact) });
  } finally {
    if (previousStateDir === undefined) delete process.env.LUXE_STATE_DIR;
    else process.env.LUXE_STATE_DIR = previousStateDir;
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedSidecar({ state, key, store }, index, extra = {}) {
  await store.saveWhiteboard(state, key, index, {
    sourceHash: "hash",
    textMetricsVersion: 2,
    scene: { elements: [{ id: "A", type: "rectangle" }], appState: {}, files: {} },
    baseline: { elements: [{ id: "A", type: "rectangle" }] },
    ...extra,
  });
}

test("save-diagram keeps the only whiteboard without needing an index", async () => {
  await withSaveDiagramFixture(async (fixture) => {
    await seedSidecar(fixture, 0);

    const output = await saveDiagramCommand([fixture.artifact]);

    assert.equal(output.saved_whiteboard.diagram_index, 0);
    assert.equal(output.saved_whiteboard.retained, true);
    assert.equal(output.saved_whiteboard.scene_path, `${fixture.realArtifact.replace(/\.html$/, "")}.wb0.excalidraw`);
    assert.equal(JSON.parse(await readFile(output.saved_whiteboard.scene_path, "utf8")).type, "excalidraw");
    assert.equal(await fixture.store.isWhiteboardRetained(fixture.state, fixture.key, 0), true);
    // No PNG has been exported yet, so the result says so instead of pretending.
    assert.equal(output.saved_whiteboard.preview_path, "");
    assert.match(output.next_step, /No PNG was written/);
  });
});

test("save-diagram reuses the PNG the browser already exported", async () => {
  await withSaveDiagramFixture(async (fixture) => {
    await seedSidecar(fixture, 0);
    await fixture.store.writeWhiteboardFeedbackFiles(fixture.state, fixture.key, 0, {
      scene: { elements: [], appState: {}, files: {} },
      pngDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    });

    const output = await saveDiagramCommand([fixture.artifact]);

    assert.ok(output.saved_whiteboard.preview_path.endsWith(".wb0.png"));
    assert.ok((await readFile(output.saved_whiteboard.preview_path)).length > 0);
    assert.match(output.next_step, /survive session cleanup/);
  });
});

test("save-diagram refuses to guess when the artifact has several whiteboards", async () => {
  await withSaveDiagramFixture(async (fixture) => {
    await seedSidecar(fixture, 0);
    await seedSidecar(fixture, 2);

    await assert.rejects(saveDiagramCommand([fixture.artifact]), (error) => {
      const failure = /** @type {AxiError & { suggestions: string[] }} */ (error);
      assert.ok(failure instanceof AxiError);
      assert.match(failure.message, /2 whiteboards/);
      assert.ok(failure.suggestions.some((item) => item.includes("0, 2")));
      return true;
    });

    const output = await saveDiagramCommand([fixture.artifact, "--diagram", "2"]);
    assert.equal(output.saved_whiteboard.diagram_index, 2);
  });
});

test("save-diagram explains itself when there is nothing to save", async () => {
  await withSaveDiagramFixture(async (fixture) => {
    await assert.rejects(saveDiagramCommand([fixture.artifact]), (error) => {
      assert.match(String(/** @type {Error} */ (error).message), /No whiteboard scenes exist/);
      return true;
    });

    await seedSidecar(fixture, 0);
    await assert.rejects(saveDiagramCommand([fixture.artifact, "--diagram", "5"]), (error) => {
      const failure = /** @type {AxiError & { suggestions: string[] }} */ (error);
      assert.match(failure.message, /No whiteboard scene for diagram 5/);
      assert.ok(failure.suggestions.some((item) => item.includes("0")));
      return true;
    });

    await assert.rejects(saveDiagramCommand([]), (error) => {
      assert.match(String(/** @type {Error} */ (error).message), /HTML file path is required/);
      return true;
    });
  });
});

test("save-diagram help and the command set advertise the ephemeral contract", () => {
  const help = getCommandHelp("save-diagram");

  assert.match(help, /Whiteboard scenes are ephemeral by default/);
  assert.match(help, /<artifact-basename>\.wb<n>\.excalidraw/);
  assert.match(help, /counting from 0/);
  assert.deepEqual(normalizeArgv(["save-diagram", "a.html"]), ["save-diagram", "a.html"]);
});
