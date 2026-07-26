import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError, RESERVED_COMMANDS, runAxiCli } from "axi-sdk-js";

import { createDesignOutput, DESIGN_PRIORITY_RULE, DESIGN_SYSTEM_HINT } from "./design-reference.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { clientHost, defaultPort, ensureStateDir, hostForUrl, serverLogFile, stateDir, stateFile } from "./paths.js";
import { findPlaybook, listPlaybooks, playbookIds, PLAYBOOK_ROUTER_HELP } from "./playbooks.js";
import { PIERRE_DIFFS_ASSET_FILE, PIERRE_DIFFS_SHA384 } from "./pierre-diffs-vendor.js";
import { resolveExportAssetPath, serve } from "./server.js";
import { canonicalFile, sessionKey, SessionStore } from "./session-store.js";
import {
  listSessionWhiteboards,
  loadWhiteboard,
  savedWhiteboardPaths,
  saveWhiteboardToMachine,
  whiteboardFeedbackPaths,
} from "./whiteboard-store.js";

const COMMANDS = new Set([
  "open",
  "poll",
  "end",
  "stop",
  "server",
  "playbook",
  "design",
  "export",
  "save-diagram",
  "copy-code-assets",
]);
// SDK-reserved built-ins (e.g. `update`) must reach runAxiCli untouched; otherwise
// the bare-arg normalization below would rewrite them into the hidden `open` command.
const RESERVED = new Set(RESERVED_COMMANDS);
const DESCRIPTION =
  "Luxe Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Luxe Editor. " +
  "First generate an interactive HTML artifact according to user request, then run `luxe <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `luxe poll`.";
export const POLL_WAKE_PATH_RULES = Object.freeze([
  "Keep the poll in the foreground by default and let it return the feedback directly to the agent.",
  "A background poll is allowed only through a harness-native tracked background-job facility whose completion result is guaranteed to resume or notify the same agent.",
  "Never use `nohup`, shell `&`, `disown`, redirected fire-and-forget processes, or a detached terminal without an explicit verified callback merely to keep polling alive.",
  "If the harness has no completion-aware background facility, use the foreground poll or first wire a verified wake callback into the surrounding supervisor.",
  "Do not tell the user the artifact is being monitored until that wake path is live.",
  "If the poll gets killed or times out anyway, just re-run it - queued feedback is never lost.",
]);
export const POLL_SEND_AND_END_RULE =
  "`Send & End` ends the session. Its final feedback is still delivered once. After that response, polling stops, and the agent must not reopen the session uninvited.";
const CODEX_POLL_WAKE_PATH_GUIDANCE =
  "Codex detected: completed background tasks may not resume Codex automatically, so keep the poll attached to the active turn.";
// Inlined at build time from package.json; falls back to reading package.json so source-run tests work.
export const VERSION =
  process.env.LUXE_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function detectInvokingAgent(env = process.env) {
  return ["CODEX_SANDBOX", "CODEX_THREAD_ID"].some((key) => Object.hasOwn(env, key)) ? "codex" : "generic";
}

export function shouldNarratePollWaitTicks({ isTTY }) {
  return Boolean(isTTY);
}

export function pollExecutionGuidance({ agent = "generic" } = {}) {
  const sharedGuidance = POLL_WAKE_PATH_RULES.join(" ");
  const agentGuidance = agent === "codex" ? ` ${CODEX_POLL_WAKE_PATH_GUIDANCE}` : "";
  return `${sharedGuidance}${agentGuidance}`;
}

export async function run(argv) {
  await ensureStateDir();
  const normalizedArgv = normalizeArgv(argv);
  const agent = detectInvokingAgent(process.env);
  const isTopLevelHelp = argv.length === 1 && argv[0] === "--help";
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv: isTopLevelHelp ? [] : normalizedArgv,
    topLevelHelp: createTopLevelHelp({ agent }),
    home: async () =>
      createHomeOutput({
        bin: process.argv[1] || "luxe",
        sessions: isTopLevelHelp ? [] : await visibleSessions(),
        includeSessions: !isTopLevelHelp,
        agent,
      }),
    commands: {
      open: openCommand,
      poll: pollCommand,
      end: endCommand,
      stop: stopCommand,
      playbook: playbookCommand,
      design: designCommand,
      server: serverCommand,
      export: exportCommand,
      "save-diagram": saveDiagramCommand,
      "copy-code-assets": copyCodeAssetsCommand,
    },
    getCommandHelp: (command) => getCommandHelp(command, { agent }),
  });
}

export function collapseHomeDirectory(file, home) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");

  if (normalizedFile === normalizedHome) {
    return "~";
  }
  if (normalizedFile.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedFile.slice(normalizedHome.length + 1)}`;
  }
  return file;
}

export function normalizeArgv(argv) {
  const first = argv[0];
  if (!first || COMMANDS.has(first) || RESERVED.has(first)) {
    return argv;
  }
  if (first.startsWith("-")) {
    return argv.some((arg) => isHtmlPath(arg)) ? ["open", ...argv] : argv;
  }
  return ["open", ...argv];
}

export function createHomeOutput({ bin, sessions, includeSessions = true, agent = "generic" }) {
  return {
    bin: collapseHomeDirectory(bin, os.homedir()),
    description: DESCRIPTION,
    ...(includeSessions
      ? {
          sessions: sessions.map((session) => ({
            file: session.file,
            status: session.status,
            url: session.url,
            pending_prompts: session.pending_prompts || 0,
          })),
        }
      : {}),
    visual_guidance: [
      "Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance",
      "Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose",
      "Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view",
      "Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately",
      "When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions",
    ],
    playbooks: listPlaybooks(),
    help: [
      "Run `luxe <html-file>` to open or resume a Luxe Editor session. If the user explicitly ended the session from the browser, this refuses to reopen it and explains why instead of reopening uninvited - pass `--reopen` only when the user asks for further review or something important needs their visual attention",
      "Unless the user specifies another location, create HTML artifacts in the current working directory under `.luxe/`",
      "Luxe serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work",
      `Run \`luxe poll <html-file>\` to wait for user feedback or browser-proven severe layout failures. It long-polls and stays silent until the user sends feedback, ends the session, or the real browser proves meaningful content is inaccessible or unusable, so leave it running - never kill it. Repair and re-check every returned layout failure before involving the human; cosmetic, intentional, transient, tiny, and uncertain observations stay silent. ${pollExecutionGuidance({ agent })} ${POLL_SEND_AND_END_RULE}`,
      "Every Send from the browser also delivers `dom_snapshot`, a text outline of the rendered artifact, so you have page context for the feedback - it captures whatever the artifact renders as text, including anything sensitive shown in a table, code block, or config listing",
      'Rendered Mermaid diagrams in `.mermaid` containers stay themed Mermaid in the page and carry a quiet Edit affordance that opens them as a full-viewport, editable Excalidraw whiteboard - flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other types open as an image to draw on. Scenes autosave locally; when a reload detects a changed Mermaid source, the reviewer explicitly chooses to re-convert and discard saved edits or keep editing the saved scene. Standalone and exported copies still render plain Mermaid. Queue feedback adds a prompt to the Conversation panel; when the user sends it, poll returns a tag "whiteboard" prompt carrying a bounded edit summary plus local scenePath (.excalidraw JSON) and previewPath (PNG) files - read the summary first, open the files only when needed, then apply the edits by updating the Mermaid source in the artifact (never try to write the scene back)',
      "Whiteboards are EPHEMERAL: every scene is deleted when the session ends, when the idle server shuts down, or by the sweep at the next server start. Keeping one is explicit - the user presses Save to machine in the whiteboard, or asks you to, and you run `luxe save-diagram <html-file> [--diagram <n>]`, which writes <artifact-basename>.wb<n>.excalidraw and .png next to the artifact and exempts that scene from cleanup",
      "Run `luxe end <html-file>` to end a session as the agent - ending it this way still allows a plain reopen later. When the user ends it from the browser instead, a later `luxe <html-file>` refuses to reopen it without `--reopen`",
      "Run `luxe export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Luxe server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu",
      "Before using the code playbook, run `luxe copy-code-assets <html-file>` to place its hash-checked browser bundle next to the artifact. Keep that local classic script until `luxe export` inlines it.",
      "Run `luxe stop` to shut down the background server (it also self-stops when idle or after the last session ends with nothing connected)",
      `Run \`luxe playbook <playbook_id>\` for focused artifact guidance. ${PLAYBOOK_ROUTER_HELP}`,
      DESIGN_SYSTEM_HINT,
      "Use luxe when the user asks for a visual artifact, HTML explainer, interactive prototype, review surface, product or technical plan, comparison, report, or browser-based feedback loop",
    ],
  };
}

export function createPlaybookOutput(args) {
  const id = args[0];
  if (!id) {
    return {
      playbooks: listPlaybooks(),
      help: ["Run `luxe playbook <playbook_id>` for focused artifact guidance", PLAYBOOK_ROUTER_HELP],
    };
  }

  const playbook = findPlaybook(id);
  if (!playbook) {
    throw new AxiError(`Unknown playbook: ${id}`, "VALIDATION_ERROR", [
      `Run \`luxe playbook\` to list known IDs: ${playbookIds().join(", ")}`,
    ]);
  }

  return { playbook };
}

export async function copyCodeAssetsCommand(args) {
  const artifact = await canonicalFile(String(args[0] || ""));
  const source = fileURLToPath(new URL(`../dist/design/${PIERRE_DIFFS_ASSET_FILE}`, import.meta.url));
  const destination = path.join(path.dirname(artifact), PIERRE_DIFFS_ASSET_FILE);
  const sourceBytes = await readFile(source);
  const sourceDigest = `sha384-${createHash("sha384").update(sourceBytes).digest("base64")}`;
  if (sourceDigest !== PIERRE_DIFFS_SHA384) {
    throw new AxiError("Vendored code-review asset failed its integrity check", "INTERNAL_ERROR", [
      `Expected ${PIERRE_DIFFS_SHA384}; rebuild this Luxe installation before copying code assets.`,
    ]);
  }
  try {
    const existing = await readFile(destination);
    if (!existing.equals(sourceBytes)) {
      throw new AxiError("Refusing to overwrite a different code-review asset", "VALIDATION_ERROR", [
        `Remove or rename ${destination} before running \`luxe copy-code-assets\` again.`,
      ]);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await copyFile(source, destination);
  }
  return { code_asset: { file: destination, integrity: PIERRE_DIFFS_SHA384 } };
}

export function createOpenOutput({ file, url, status, agent = "generic" }) {
  return {
    session: { file, url, status },
    next_step: `Do not respond to the user just yet. Now you must run \`luxe poll ${file}\`. This command long-polls until the user sends feedback, ends the session, or the real browser proves a severe layout failure through the in-iframe audit, and it stays silent the whole time - that is normal, never kill it. If layout_warnings arrive, follow the poll response's next_step: repair and re-check the inaccessible or unusable content before involving the human. Cosmetic, intentional, transient, tiny, and uncertain observations stay silent. Do not pass --timeout-ms during normal agent use. ${pollExecutionGuidance({ agent })} After applying feedback, run \`luxe poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms to show your response in Luxe Editor and wait for more feedback. If the user ends the session, stop polling and do not reopen it by re-running \`luxe ${file}\` unless the user asks for further review or something genuinely important needs their visual attention - deliver routine updates directly in this conversation instead. When reopening is warranted, run \`luxe ${file} --reopen\`.`,
  };
}

// Shown when a plain `luxe <file>` targets a session the user explicitly ended from the
// browser. Reviving it silently would reopen a browser window the human deliberately closed, so
// this refuses and requires the explicit --reopen opt-in instead of erroring - the session
// staying closed is the correct, idempotent outcome unless the agent has a real reason to reopen.
export function createUserEndedOpenOutput({ file, url }) {
  return {
    session: { file, url, status: "user-ended" },
    next_step: `The user explicitly ended this Luxe Editor session from the browser, so \`luxe ${file}\` did not reopen it. Do not reopen unless the user asks for further review or something genuinely important needs their visual attention - deliver routine updates directly in this conversation instead. When reopening is warranted, run \`luxe ${file} --reopen\`.`,
  };
}

async function openCommand(args) {
  const file = firstPositionalArg(args);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `luxe <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const noGate = args.includes("--no-gate");
  const reopen = args.includes("--reopen");
  const baseUrl = await ensureServer({ forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || "") });
  const response = await postJson(`${baseUrl}/api/sessions`, { file: absolute, noGate, reopen });
  if (response.status === "user-ended") {
    return createUserEndedOpenOutput({ file: absolute, url: response.url });
  }
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
    } catch {
      response.status = "ready";
    }
  }
  return createOpenOutput({
    file: absolute,
    url: response.url,
    status: response.status || "opened",
    agent: detectInvokingAgent(process.env),
  });
}

export function shouldOpenBrowser(args, env) {
  return !args.includes("--no-open") && env.LUXE_NO_OPEN !== "1";
}

async function pollCommand(args) {
  const file = firstPositionalArg(args, ["--agent-reply", "--timeout-ms"]);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `luxe poll <html-file>`"]);
  }
  const absolute = await canonicalFile(file);
  const baseUrl = await ensureServer();
  const agentReply = flagValue(args, "--agent-reply");
  if (agentReply) {
    await postJson(`${baseUrl}/api/${sessionKey(absolute)}/agent-reply`, { text: agentReply });
  }
  const timeoutMs = flagValue(args, "--timeout-ms");
  // The indefinite poll looks hung from the agent's side (stdout stays empty until the user
  // acts), so narrate the wait on stderr and leave re-run guidance behind if the agent's
  // harness kills the process anyway. stderr keeps the stdout JSON contract intact.
  // The one-shot banner is that "not hung" signal and stays unconditional; only the recurring
  // ticks - one line per minute, unbounded - are gated on an interactive stderr so piped,
  // merged agent captures do not accumulate them.
  const onPollSignal = (signal) => {
    process.stderr.write(`\n${pollInterruptedText(absolute)}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (!timeoutMs) {
    // Register before the banner write below: a harness that kills the poll as soon as the
    // banner appears can deliver the signal before the next statement runs, and without a
    // handler the default disposition exits silently with no re-run guidance.
    process.on("SIGINT", onPollSignal);
    process.on("SIGTERM", onPollSignal);
  }
  const waitReporter = timeoutMs
    ? null
    : startPollWaitReporter({
        file: absolute,
        narrateTicks: shouldNarratePollWaitTicks({ isTTY: process.stderr.isTTY }),
      });
  try {
    const response = await fetchJson(`${baseUrl}/api/poll`, {
      retries: 3,
      retryDelayMs: 500,
      request: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: absolute, ...(timeoutMs ? { timeoutMs } : {}) }),
      },
    });
    return createPollOutput({ file: absolute, response, agent: detectInvokingAgent(process.env) });
  } finally {
    waitReporter?.stop();
    if (!timeoutMs) {
      process.off("SIGINT", onPollSignal);
      process.off("SIGTERM", onPollSignal);
    }
  }
}

export function pollWaitBannerText(file) {
  return (
    `[luxe] Long-polling for user feedback or layout_warnings on ${file}. This stays silent until the user sends feedback, ends the session, or the browser reports fresh layout_warnings - leave it running. ` +
    `If it gets killed or times out, re-run \`luxe poll ${file}\` - queued feedback is never lost.`
  );
}

export function pollWaitTickText(elapsedMs) {
  const minutes = Math.round(elapsedMs / 60_000);
  return `[luxe] Still waiting for user feedback (${minutes}m). Also waiting for fresh layout_warnings. Leave this running until the user acts or the browser reports fresh layout_warnings.`;
}

export function pollInterruptedText(file) {
  return (
    `[luxe] Poll interrupted before user feedback arrived. The user may still be reviewing - ` +
    `re-run \`luxe poll ${file}\` to keep waiting; queued feedback is never lost.`
  );
}

export function startPollWaitReporter({
  file,
  write = (line) => {
    process.stderr.write(line);
  },
  intervalMs = 60_000,
  narrateTicks = true,
}) {
  write(`${pollWaitBannerText(file)}\n`);
  if (!narrateTicks) return { stop: () => {} };
  let elapsedMs = 0;
  const timer = setInterval(() => {
    elapsedMs += intervalMs;
    write(`${pollWaitTickText(elapsedMs)}\n`);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * @returns {{
 *   session: { file: string, status: string, session_ended?: boolean, ended_by?: string },
 *   next_step?: string,
 *   dom_snapshot?: string,
 *   prompts?: any[],
 *   layout_warnings?: any[],
 * }}
 */
export function createPollOutput({ file, response, agent = "generic" }) {
  if (response.status === "missing") {
    throw new AxiError("No active Luxe Editor session for this file", "NOT_FOUND", [`Run \`luxe ${file}\` first`]);
  }
  if (response.status === "feedback") {
    const layoutWarnings = Array.isArray(response.layout_warnings)
      ? response.layout_warnings.filter(
          (warning) => warning && String(warning.severity || "").toLowerCase() === "error",
        )
      : [];
    const sessionEnded = Boolean(response.session_ended);
    const endedBy = typeof response.ended_by === "string" ? response.ended_by : undefined;
    return {
      session: {
        file,
        status: "feedback",
        ...(sessionEnded ? { session_ended: true, ...(endedBy ? { ended_by: endedBy } : {}) } : {}),
      },
      dom_snapshot: response.dom_snapshot || "",
      prompts: response.prompts || [],
      ...(layoutWarnings.length > 0 ? { layout_warnings: layoutWarnings } : {}),
      next_step: createFeedbackNextStep(file, layoutWarnings, sessionEnded, endedBy, response.prompts || [], agent),
    };
  }
  if (response.status === "ended") {
    return {
      session: { file, status: "ended", ...(response.ended_by ? { ended_by: response.ended_by } : {}) },
      next_step: createEndedNextStep(file, response.ended_by),
    };
  }
  return {
    session: { file, status: response.status || "waiting" },
    next_step: `No user feedback arrived before the optional timeout. Run \`luxe poll ${file}\` without --timeout-ms to wait indefinitely - queued feedback is never lost, so re-running the poll is always safe.`,
  };
}

function createFeedbackNextStep(file, layoutWarnings, sessionEnded, endedBy, prompts = [], agent = "generic") {
  const count = layoutWarnings.length;
  const whiteboardNote = prompts.some((prompt) => prompt && prompt.tag === "whiteboard")
    ? `This feedback includes whiteboard edits (tag "whiteboard"): read the edit summary in the prompt text first, and only when it is not enough, open the target's scenePath (.excalidraw scene JSON) or previewPath (PNG) local files for detail. The artifact's Mermaid source stays authoritative - apply the edits by updating the Mermaid text in ${file} (Luxe live-reloads it); never try to write the .excalidraw scene back. `
    : "";
  if (sessionEnded) {
    const layoutNote =
      count > 0
        ? endedBy === "user"
          ? `${count} proven severe layout failure${count === 1 ? "" : "s"} arrived alongside this final feedback. Repair the inaccessible or unusable content in ${file}, then open it directly at the affected viewport and confirm the content or control is visible and usable without reopening this ended Luxe session. `
          : `${count} proven severe layout failure${count === 1 ? "" : "s"} arrived alongside this final feedback. Repair the inaccessible or unusable content in ${file}, then run \`luxe ${file}\` to open a fresh session and re-check the real-browser audit. `
        : "";
    if (endedBy === "user") {
      const reopenNote =
        count > 0
          ? ""
          : ` Only run \`luxe ${file} --reopen\` if the user explicitly asks for further review or something genuinely important needs their visual attention.`;
      return `${layoutNote}${whiteboardNote}This was the last feedback before the user ended the session. Stop polling ${file} and do not reopen it - deliver any remaining updates directly in this conversation instead.${reopenNote}`;
    }
    return `${layoutNote}${whiteboardNote}This was the last feedback before the Luxe Editor session ended. Stop polling ${file}. Deliver any remaining updates directly in this conversation, or run \`luxe ${file}\` to open a fresh session if the user needs further visual review.`;
  }
  const layoutPrefix =
    count > 0 ? layoutWarningsPrefix(file, layoutWarnings) : `Apply the requested changes to ${file}. `;
  return `${layoutPrefix}${whiteboardNote}Do not respond to the user just yet. Now you must run \`luxe poll ${file} --agent-reply "<message for the user>"\` without --timeout-ms unless the user ended the session. The poll waits silently until the user sends more feedback, ends the session, or reports fresh layout_warnings - never kill it. ${pollExecutionGuidance({ agent })}`;
}

// Layout findings reach this path only after the browser has direct, stable evidence that
// meaningful content or a required control is inaccessible or unusable. Cosmetic and uncertain
// observations are discarded before storage, so every returned failure still requires repair.
function layoutWarningsPrefix(file, layoutWarnings) {
  const count = layoutWarnings.length;
  const plural = count === 1 ? "" : "s";
  return `${count} proven severe layout failure${plural} detected - repair the inaccessible or unusable content in ${file}, then re-check in the browser before involving the human. Luxe live-reloads the artifact automatically after you save, so you do not need to re-run \`luxe ${file}\` for this. `;
}

function createEndedNextStep(file, endedBy) {
  if (endedBy === "user") {
    return `The user ended this Luxe Editor session. Stop polling ${file} - do not run \`luxe ${file}\` to reopen it. Deliver any remaining updates directly in this conversation instead. Only reopen with \`luxe ${file} --reopen\` if the user explicitly asks for further review or something genuinely important needs their visual attention.`;
  }
  return `This Luxe Editor session for ${file} has ended. Stop polling. Deliver any remaining updates directly in this conversation, or run \`luxe ${file}\` to open a fresh session if the user needs further visual review.`;
}

async function endCommand(args) {
  const file = firstPositionalArg(args);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `luxe end <html-file>`"]);
  }
  const absolute = await canonicalFile(file);
  const baseUrl = await ensureServer();
  const response = await postJson(`${baseUrl}/api/end`, { file: absolute });
  return { session: { file: absolute, status: response.status || "ended" } };
}

// The agent-facing half of D5's "Save to machine", so "save that diagram" works from the
// conversation rather than only from the fullscreen editor's button. It writes the same two
// files to the same place and sets the same retain marker.
//
// It works directly on the sidecar rather than through the server: the browser control's
// route is same-origin guarded, which is exactly right for a browser control and exactly
// wrong for a CLI (a header-less request would be rejected). Reading the state directory the
// CLI already owns needs no route and widens no guard.
export async function saveDiagramCommand(args) {
  const file = firstPositionalArg(args, ["--diagram"]);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", [
      "Run `luxe save-diagram <html-file> [--diagram <n>]`",
    ]);
  }
  const absolute = await canonicalFile(file);
  const key = sessionKey(absolute);
  const root = stateDir();
  const available = await listSessionWhiteboards(root, key);
  if (available.length === 0) {
    throw new AxiError(`No whiteboard scenes exist for ${absolute}`, "VALIDATION_ERROR", [
      "A diagram becomes a whiteboard the first time someone opens it with the Edit affordance in the browser.",
    ]);
  }
  const requested = flagValue(args, "--diagram");
  let index;
  if (requested === null) {
    if (available.length > 1) {
      throw new AxiError(`This artifact has ${available.length} whiteboards; say which one`, "VALIDATION_ERROR", [
        `Run \`luxe save-diagram ${file} --diagram <n>\` with one of: ${available.join(", ")}`,
      ]);
    }
    index = available[0];
  } else {
    index = Number(requested);
    if (!available.includes(index)) {
      throw new AxiError(`No whiteboard scene for diagram ${requested}`, "VALIDATION_ERROR", [
        `Available diagram indices: ${available.join(", ")}`,
      ]);
    }
  }
  const record = await loadWhiteboard(root, key, index);
  if (!record?.scene) {
    throw new AxiError(`Whiteboard ${index} has no saved scene yet`, "VALIDATION_ERROR", [
      "Open it in the browser once so the editor autosaves a scene, then try again.",
    ]);
  }
  // Reuse the PNG the browser already exported at queue time when there is one. Rendering a
  // new one would need a browser, and the CLI has none - so the honest outcome is the scene
  // plus whatever preview exists, and a next_step that says which.
  const { previewPath: feedbackPng } = whiteboardFeedbackPaths(root, key, index);
  const pngDataUrl = await readFile(feedbackPng)
    .then((bytes) => `data:image/png;base64,${bytes.toString("base64")}`)
    .catch(() => "");
  const { scenePath, previewPath } = await saveWhiteboardToMachine(root, key, index, {
    artifactFile: absolute,
    scene: record.scene,
    pngDataUrl,
  });
  return {
    saved_whiteboard: {
      artifact: absolute,
      diagram_index: index,
      scene_path: scenePath,
      preview_path: previewPath,
      retained: true,
    },
    next_step: previewPath
      ? `Kept diagram ${index} as ${scenePath} and ${previewPath}. Both survive session cleanup; every other whiteboard for this artifact is deleted when the session ends.`
      : `Kept diagram ${index} as ${scenePath}. No PNG was written because none has been exported yet - press Queue feedback or Save to machine in the browser once if the user wants the image too. The expected path would be ${savedWhiteboardPaths(absolute, index).previewPath}.`,
  };
}

// Produce a portable copy of an artifact: one HTML file with its LOCAL assets (relative-path
// stylesheets, scripts, images, fonts) inlined as data URIs. Remote CDN/font references are left
// as-is for the browser to load, so the export needs network to render those. Luxe makes no
// outbound requests - export is a pure local file transform, server-independent.
async function exportCommand(args) {
  const file = firstPositionalArg(args, ["--out"]);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `luxe export <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const root = path.dirname(absolute);
  const output = path.resolve(flagValue(args, "--out") || path.join(root, exportFileName(absolute)));
  const source = await readFile(absolute, "utf8");
  const { html, warnings } = await buildSelfContainedHtml(source, {
    baseDir: root,
    confineDir: root,
    resolveAbsolute: resolveExportAssetPath,
  });
  await writeFile(output, html);
  return createExportOutput({ source: absolute, output, html, warnings });
}

export function createExportOutput({ source, output, html, warnings }) {
  const allWarnings = Array.isArray(warnings) ? warnings : [];
  const { unresolved, notices } = splitExportWarnings(allWarnings);
  const result = {
    export: {
      source,
      output,
      bytes: Buffer.byteLength(html),
      unresolved_local_assets: unresolved.length,
      notices: notices.length,
    },
  };
  if (allWarnings.length) result.warnings = exportWarningSummaries(allWarnings);
  if (unresolved.length) result.unresolved_local_assets = exportWarningSummaries(unresolved);
  if (notices.length) result.notices = exportWarningSummaries(notices);
  if (unresolved.length) {
    result.next_step =
      "Some LOCAL assets could not be inlined and were left as references (see unresolved_local_assets); they will break once the file is moved. Remote CDN/font references are intentionally left as links and render where there is network access.";
  } else if (notices.length) {
    result.next_step = `Wrote ${output} with export notices (see notices). Open it directly or host it anywhere - it needs no Luxe server. Local assets are inlined; remote CDN/font references are left as links, so it needs network to render those.`;
  } else {
    result.next_step = `Wrote ${output}. Open it directly or host it anywhere - it needs no Luxe server. Local assets are inlined; remote CDN/font references are left as links, so it needs network to render those.`;
  }
  return result;
}

// Explicitly shut down the running Luxe Editor server. Unlike `end` (which closes a single
// session), this stops the background process so it stops dangling between sessions.
export async function stopCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  return shutdownServerOnPort(port, { baseUrl, currentVersion: VERSION });
}

export async function shutdownServerOnPort(
  port,
  {
    baseUrl = `http://${hostForUrl(clientHost())}:${port}`,
    currentVersion = VERSION,
    fetchHealth: healthFetcher = fetchHealth,
    requestShutdown: shutdownRequester = requestShutdown,
    waitForPortFree: portFreeWaiter = waitForPortFree,
    killProcessOnPort: portKiller = killProcessOnPort,
    processMatchesLuxe = processOnPortMatchesLuxe,
  } = {},
) {
  const health = await healthFetcher(baseUrl);
  if (!health) {
    return { server: { status: "not-running", port } };
  }
  if (!(await canControlServerOnPort(port, health, processMatchesLuxe))) {
    return { server: { status: "not-luxe", port } };
  }
  await shutdownRequester(baseUrl);
  let freed = await portFreeWaiter(baseUrl, 3000);
  if (!freed && shouldKillProcessOnPort(currentVersion, health)) {
    portKiller(port);
    freed = await portFreeWaiter(baseUrl, 3000);
  }
  return { server: { status: freed ? "stopped" : "stopping", port } };
}

async function playbookCommand(args) {
  return createPlaybookOutput(args);
}

async function designCommand() {
  return createDesignOutput();
}

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const debug = args.includes("--verbose") || process.env.LUXE_DEBUG === "1";
  const server = await serve({ port, stateFile: stateFile(), version: VERSION, debug });
  await server.done;
  return "";
}

async function visibleSessions() {
  const store = new SessionStore(stateFile());
  return (await store.listSessions()).filter((session) => session.status !== "ended");
}

async function assertHtmlFile(file) {
  if (!isHtmlPath(file)) {
    throw new AxiError("Luxe Editor expects an HTML file", "VALIDATION_ERROR", ["Run `luxe <html-file>`"]);
  }
  try {
    await access(file);
  } catch {
    throw new AxiError(`File not found: ${file}`, "NOT_FOUND", [
      "Create the HTML artifact first, then run `luxe <html-file>`",
    ]);
  }
}

function isHtmlPath(file) {
  return file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm");
}

async function ensureServer({ forceRestart = false } = {}) {
  const port = defaultPort();
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  const existing = await fetchHealth(baseUrl);
  if (existing && !shouldRestartServer(VERSION, existing, forceRestart)) {
    return baseUrl;
  }
  if (existing) {
    if (!(await canControlServerOnPort(port, existing, processOnPortMatchesLuxe))) {
      throw new AxiError(`Port ${port} is occupied by a non-Luxe server`, "SERVER_ERROR", [
        `Stop the process using port ${port}, or set LUXE_PORT to another port`,
      ]);
    }
    // Stale server from an older release is squatting on the port. Ask it to shut down
    // gracefully so the upgraded client doesn't keep handing users an old chrome.
    await requestShutdown(baseUrl);
    const freed = await waitForPortFree(baseUrl, 2000);
    if (!freed) {
      // Pre-handshake servers (any release older than this change) don't expose /shutdown
      // so the POST 404'd. Fall back to SIGTERM by PID so the very first upgrade still
      // works, then keep waiting.
      if (shouldKillProcessOnPort(VERSION, existing)) {
        killProcessOnPort(port);
        await waitForPortFree(baseUrl, 3000);
      }
    }
  }
  await startServer(port);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl);
    if (health && !shouldRestartServer(VERSION, health)) {
      return baseUrl;
    }
    await delay(100);
  }
  throw new AxiError("Luxe Editor server did not start", "SERVER_ERROR", [
    `Run \`luxe server --port ${port}\` to inspect server startup`,
    // The detached server writes its own startup failure to the log, so the cause
    // (most often another process already listening on the port) is one file away.
    "Inspect `~/.luxe/server.log` (`LUXE_STATE_DIR/server.log` when set) for the reason the server exited",
    `Set LUXE_PORT to a free port if another process already listens on ${port}`,
  ]);
}

// Pure helper so the upgrade-detection logic is unit-testable without spinning up HTTP.
// Returns true when the running server is a different (or pre-handshake) version than
// what this CLI was built with - i.e. the user just upgraded and the stale server needs
// to step aside.
export function shouldRestartServer(currentVersion, healthBody, forceRestart = false) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (forceRestart && healthBody.app === "luxe") return true;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  return healthBody.version !== currentVersion;
}

export function shouldForceRestartForLocalBuild(executablePath, sourceServerExists = localSourceServerExists()) {
  const localBuildEntry = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  return sourceServerExists && path.resolve(executablePath) === path.resolve(localBuildEntry);
}

function localSourceServerExists() {
  return existsSync(fileURLToPath(new URL("../src/server.js", import.meta.url)));
}

export function shouldKillProcessOnPort(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  if (healthBody.app !== "luxe") return false;
  return healthBody.version !== currentVersion;
}

async function canControlServerOnPort(port, healthBody, processMatchesLuxe) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (healthBody.app === "luxe") return true;
  if (typeof healthBody.version === "string" && healthBody.version !== "") return false;
  return processMatchesLuxe(port);
}

async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function requestShutdown(baseUrl) {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // Best effort. If the server died before answering, the port will free up on its own.
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) return true;
    await delay(100);
  }
  return false;
}

// Last-resort fallback for the bootstrap upgrade case: a pre-handshake server is squatting
// on the port and doesn't expose /shutdown, so we resolve its PID via lsof and SIGTERM it.
// macOS/Linux only - Windows users would need to kill manually, but luxe isn't
// shipped for Windows today.
function killProcessOnPort(port) {
  try {
    const result = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process already gone or permission denied - either way nothing we can do.
        }
      }
    }
  } catch {
    // lsof missing or unsupported platform - the outer caller will surface SERVER_ERROR.
  }
}

function processOnPortMatchesLuxe(port) {
  try {
    const pids = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (pids.status !== 0) return false;
    for (const line of pids.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.status === 0 && /luxe/.test(command.stdout)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function startServer(port) {
  await ensureStateDir();
  const entry = resolveServerEntry();
  let logFd = null;
  try {
    // Owner-only like the rest of the state directory: the log records artifact file paths.
    logFd = openSync(serverLogFile(), "a", 0o600);
  } catch {
    // If logging cannot be initialized, keep the server behavior unchanged.
  }
  try {
    const child = spawn(process.execPath, [entry, "server", "--port", String(port)], createServerSpawnOptions(logFd));
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

// The detached server child must point at a node-executable entry that actually invokes
// run(). In source layout that's `../bin/luxe.js` (which calls run on import). In the
// published bundle, only `dist/cli.mjs` ships and it self-invokes via the bundled bin
// wrapper. Pick whichever exists.
export function resolveServerEntry() {
  const binEntry = fileURLToPath(new URL("../bin/luxe.js", import.meta.url));
  if (existsSync(binEntry)) return binEntry;
  return fileURLToPath(import.meta.url);
}

/**
 * @param {number | null} logFd
 * @returns {import("node:child_process").SpawnOptions}
 */
export function createServerSpawnOptions(logFd = null) {
  const stdio = /** @type {import("node:child_process").StdioOptions} */ (
    logFd === null ? "ignore" : ["ignore", logFd, logFd]
  );
  return {
    detached: true,
    stdio,
    env: { ...process.env, LUXE_NO_OPEN: "1" },
  };
}

/**
 * @param {string} url
 * @param {{ retries?: number, retryDelayMs?: number, request?: RequestInit }} [options]
 */
export async function fetchJson(url, { retries = 0, retryDelayMs = 250, request } = {}) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      response = await fetch(url, request);
      break;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw serverConnectionError();
      await delay(retryDelayMs);
    }
  }

  if (!response) throw serverConnectionError();
  if (!response.ok) {
    throw new AxiError(`Luxe Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  try {
    return await response.json();
  } catch {
    throw pollResponseInterruptedError();
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw serverConnectionError();
  }
  if (!response.ok) {
    throw new AxiError(`Luxe Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  return response.json();
}

function serverConnectionError() {
  return new AxiError("Luxe Editor server connection failed", "SERVER_ERROR", [
    "Run `luxe server --verbose` or inspect `~/.luxe/server.log` (`LUXE_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `luxe poll <html-file>` command after the server is healthy",
  ]);
}

function pollResponseInterruptedError() {
  return new AxiError("Luxe Editor poll response was interrupted", "SERVER_ERROR", [
    "Run `luxe server --verbose` or inspect `~/.luxe/server.log` (`LUXE_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `luxe poll <html-file>` command after the server is healthy",
  ]);
}

function firstPositionalArg(args, valueFlags = []) {
  const flags = new Set(valueFlags);
  let positionalMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalMode && arg === "--") {
      positionalMode = true;
      continue;
    }
    if (!positionalMode && isValueFlagToken(arg, flags)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (!positionalMode && arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === flag) return args[i + 1] || null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
  }
  return null;
}

function isValueFlagToken(arg, flags) {
  for (const flag of flags) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCommandHelp(command, { agent = "generic" } = {}) {
  return createCommandHelp({ agent })[command] || null;
}

function createTopLevelHelp({ agent = "generic" } = {}) {
  return `luxe - Luxe Editor AXI\n\nUsage:\n  luxe\n  luxe <html-file> [--no-open] [--no-gate] [--reopen]\n  luxe poll <html-file> [--agent-reply "..."]\n  luxe end <html-file>\n  luxe export <html-file> [--out <path>]\n  luxe save-diagram <html-file> [--diagram <n>]\n  luxe copy-code-assets <html-file>\n  luxe stop\n  luxe playbook [playbook_id]\n  luxe design\n\n${DESIGN_SYSTEM_HINT}\n\nNote: poll long-polls indefinitely by default until the user sends feedback, ends the session, or the browser proves a severe layout failure, staying silent while it waits - never kill it. Repair and re-check every returned layout failure before involving the human; cosmetic and uncertain observations are never returned. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. ${pollExecutionGuidance({ agent })} ${POLL_SEND_AND_END_RULE}\n\n`;
}

function createCommandHelp({ agent = "generic" } = {}) {
  return {
    open: `Usage: luxe <html-file> [--no-open] [--no-gate] [--reopen]\n\nOpen or resume a Luxe Editor review session for an HTML artifact. Use --no-open when you need to ensure the server/session exists without opening another browser window. Use --no-gate to skip the open-time layout curtain for this browser open. If the user explicitly ended the session from the browser, this refuses to reopen it and returns guidance instead - pass --reopen to force it open when the user asks for further review or something important needs their visual attention. Sessions ended by the agent (\`luxe end\`) reopen normally without the flag.\n`,
    poll: `Usage: luxe poll <html-file> [--agent-reply "..."]\n\nThis command long-polls indefinitely for queued user prompts and browser-proven severe layout failures, then returns them to the agent as layout_warnings. It stays silent while it waits - that is normal, never kill it. Repair and re-check every returned layout failure before involving the human; cosmetic and uncertain observations are never returned. Do not pass --timeout-ms during normal agent use; it is for tests and debugging only. ${pollExecutionGuidance({ agent })} Use --agent-reply after applying prior feedback to display your response in Luxe Editor before waiting again. ${POLL_SEND_AND_END_RULE}\n`,
    end: `Usage: luxe end <html-file>\n\nEnd a Luxe Editor session as the agent. A session ended this way still reopens normally on the next \`luxe <html-file>\`, unlike a user ending it from the browser, which requires --reopen.\n`,
    export: `Usage: luxe export <html-file> [--out <path>]\n\nWrite a portable copy of an artifact: one HTML file with its LOCAL assets inlined (relative-path stylesheets, scripts, images, and fonts become inline <style>/<script> blocks and data URIs). Remote CDN/font references (https URLs) are left as links for the browser to load, so the file needs network to render those. Luxe makes no outbound requests - it only reads local files, confined to the artifact's directory. Defaults to writing <name>.export.html next to the source; pass --out to choose a path. The Luxe annotation SDK is never included in an export.\n`,
    stop: `Usage: luxe stop [--port <port>]\n\nShut down the background Luxe Editor server. The server also stops itself when no browser or poll has been connected for a while (LUXE_IDLE_TIMEOUT_MS, default 30m) and immediately when the last session ends with nothing connected.\n`,
    "save-diagram": `Usage: luxe save-diagram <html-file> [--diagram <n>]\n\nKeep a whiteboard permanently. Whiteboard scenes are ephemeral by default - they live for the session and are then deleted - so this is how "save that diagram" is honoured from the conversation. Writes <artifact-basename>.wb<n>.excalidraw and <artifact-basename>.wb<n>.png next to the artifact and marks the scene retained, so no cleanup pass touches it again. <n> is the diagram's position among the artifact's .mermaid containers, counting from 0; omit --diagram when the artifact has only one whiteboard. The PNG is the one the browser last exported; if none exists yet, only the scene is written and the result says so.\n`,
    playbook: `Usage: luxe playbook [playbook_id]\n\nList focused artifact guidance playbooks, or show one playbook by ID. Known IDs: diagram, table, comparison, plan, code, input.\n\n${PLAYBOOK_ROUTER_HELP}\n\nExamples:\n  luxe playbook\n  luxe playbook diagram\n  luxe playbook input\n`,
    "copy-code-assets": `Usage: luxe copy-code-assets <html-file>\n\nCopy the hash-checked browser bundle required by the code playbook beside an existing artifact. The local classic script is safe for \`luxe export\` to inline.\n`,
    design: `Usage: luxe design\n\nShow a copy-pasteable CDN snippet for Tailwind CSS browser runtime v4 + DaisyUI v5, the Luxe theme block that maps DaisyUI's semantic variables onto the Luxe tokens, Mermaid diagram tooling, the Luxe Shiki code theme, the chart palette and its labelling rule, a content-to-playbook router, an optional layout safety CSS snippet, plus technical reference for DaisyUI components. ${PLAYBOOK_ROUTER_HELP} Luxe artifacts stay portable HTML. This CDN snippet is the design fallback, not the default: inspect the subject project before falling back, and paste the layout safety CSS only when useful for dense nested grid/flex layouts, badges, wide fonts, or local media. ${DESIGN_PRIORITY_RULE}\n`,
    server: `Usage: luxe server [--port 4387] [--verbose]\n\nRun the local Luxe Editor server. Pass --verbose (or set LUXE_DEBUG=1) to log session and watcher events to stderr. Detached server output is appended to ~/.luxe/server.log, or LUXE_STATE_DIR/server.log when set, for startup and crash diagnostics.\n\nLUXE_HOST sets the bind address (default 127.0.0.1; a wildcard 0.0.0.0 or :: binds every interface). Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. LUXE_LINK_HOST sets the hostname written into generated session links (default: the bind address, or loopback when bound to a wildcard). See the Allowed hosts section of https://github.com/snitilf/Luxe/blob/main/docs/security.md for Host allowlisting and LUXE_ALLOWED_HOSTS. LUXE_NO_OPEN=1 (or --no-open) suppresses the local browser launch.\n`,
  };
}

export { createDesignOutput };
