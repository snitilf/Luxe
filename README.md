<h1 align="center">Luxe</h1>
<p align="center">
  <a href="https://github.com/snitilf/Luxe/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/snitilf/Luxe/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/snitilf/Luxe/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/snitilf/Luxe/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/editeur-luxe"
    ><img alt="npm" src="https://img.shields.io/npm/v/editeur-luxe?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
</p>

<h3 align="center">For when a rich editor is not rich enough.</h3>

HTML is the new markdown. Luxe is the new editor for your HTML artifacts.

Agents are good at producing rich HTML artifacts, but the human-agent collaboration loop on such artifacts is lacking and falls back into screenshots and long responses for "tell me what to change."
That loses the thing HTML is best at: interactivity.

Luxe Editor opens agent-generated HTML files in a local browser, lets you pinpoint elements and selected text, edit rendered Mermaid diagrams as whiteboards, and send feedback to the agent to address.

- **Local-first** - Review local HTML artifacts with a local CLI. There is no cloud dependency anywhere in the feedback loop.
- **Human-AI collaboration** - Annotate elements and selected text ranges, edit Mermaid diagrams as whiteboards, and send messages to the agent without leaving Luxe Editor.
- **Battery included** - Luxe Editor teaches your agent good visualization for common use cases such as product or technical plans, design explorations and more out of the box.

Luxe is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- It's optimized for agent ergonomics. TOON output, long polling, and contextual disclosure making it highly token efficient.
- The skill below only handles discovery; agents learn to use the AXI by using it.

## Quick Start

Install the Luxe skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add snitilf/Luxe --skill luxe
```

That is the entire setup - no npm install needed.
The skill teaches your agent to run Luxe through `npx -y editeur-luxe`, so the CLI comes along on demand.
In restricted subprocess sandboxes, CI, or agent harnesses where `npx -y` exits opaquely, the skill also documents direct installed-copy fallbacks through the local or global npm install path.
Its frontmatter also includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it as a first-class productivity skill.
This installs the public `luxe` skill.

Note the two names: the npm package is `editeur-luxe` (the bare name `luxe` on npm is an unrelated package), while the command you type and the slash command you invoke are both `luxe`.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/luxe let's discuss our plan here
```

Or just ask for anything that is easier to grasp visually - a plan, comparison, diagram, table, code view, or report - and the agent loads the skill on its own when it recognizes the task.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example); add `-g` to install it for all projects (`~/.claude/skills/`).

## Other Ways to Use Luxe

The skill is the recommended path, but it is not the only one.

### Zero setup

Luxe is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Use `npx -y editeur-luxe` to write a product or technical plan for what we discussed.
```

### From source

```sh
git clone https://github.com/snitilf/Luxe.git
cd Luxe
npm ci
npm run build
npm link
```

## How It Works

```
┌───────────────┐
│ Agent writes  │
│ artifact.html │
└───────┬───────┘
        ▼
┌────────────────────────┐
│ luxe <file_path>       │
│ opens local browser UI │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ Human annotates text   │
│ or elements, sends     │
│ chat, or browser audit │
│ proves severe failures │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ luxe poll waits and    │
│ returns prompts or     │
│ severe failures        │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Portable artifacts** - The artifact runs in an iframe while Luxe injects a small SDK for annotations, snapshots, feedback controls, and render-time layout checks.
  Luxe does not inject any design system, so the saved HTML file renders identically whether you open it through `luxe` or directly in a browser.
  Run `luxe design` for the single source of agent-facing design guidance and optional CDN or Mermaid snippets.
- **Open-time layout gate** - The browser chrome masks an artifact only while the real in-iframe audit checks for a stable, proven severe layout failure.
  A severe failure notifies the agent through the `layout_warnings` poll path and keeps the curtain up until a clean reload, while cosmetic, intentional, transient, tiny, and uncertain observations stay silent.
  The user can click **Show anyway**, and a bounded safety timeout fails open without an issue banner when no severe failure has been proven.
- **Layout failures** - After fonts and finite animations settle, the injected SDK confirms severe failures from direct rendered evidence such as materially escaped meaningful content or required controls, clipped text fragments, viewport reachability, or near-total semantic occlusion.
  Explicit ellipsis and line clamp, standard visually hidden accessibility text, intentional scrollers or masks, parent overhang, generic element scroll geometry, decorative overlap, and uncertain motion do not produce findings by themselves.
  Proven failures are returned from `luxe poll` in `layout_warnings` with `selector`, `kind`, `axis`, `overflowPx`, `viewportWidth`, `severity`, and `persistent`.
  Every returned failure should be fixed and rechecked before asking the human to review.
- **Local assets** - Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory; root-prefixed paths such as `/assets/logo.png` will not resolve through Luxe's artifact route.
- **Export** - `luxe export` writes `<name>.export.html` by inlining local assets only, stripping the annotation SDK, and leaving remote CDN/font references as links that still need network access.
  Bundling never fetches remote URLs, Luxe itself does not set a CSP, local reads stay confined and size-capped, and absolute `file://` paths outside safe inlined asset references are redacted before output.
  Per-asset and per-bundle inline caps default to 10 MB and 25 MB, overridable with `LUXE_EXPORT_MAX_ASSET_BYTES` and `LUXE_EXPORT_MAX_BUNDLE_BYTES`.
  Unresolved local assets or export notices such as author-set CSP meta tags and redacted file URLs are surfaced in command or browser output.
- **Live reload** - Luxe watches the HTML artifact file by default and preserves the artifact iframe scroll position across reloads. To also reload on sibling asset changes, add `data-luxe-live-reload-root` to the root element or `<meta name="luxe-live-reload" content="root">`.
- **Feedback controls** - Native controls (radios, checkboxes, inputs, selects, buttons, labels, disclosure summaries, contenteditable) are interactive automatically, so they do not need `data-luxe-action`.
  For reversible choices, let option clicks update local state, then queue exactly one final answer from a per-question submit or Queue answer button with `window.luxe.queuePrompt()`.
  In-page forms fill the Conversation queue; the reviewer confirms transmission from the chrome with **Send to Agent** or **Send & End**.
  Mark only custom (non-native) clickable elements with `data-luxe-action` so Luxe does not annotate them, and use `data-luxe-question` or `queueKey` when pre-send updates for the same question should replace each other.
  Queued annotation preview pills and chat history share a scrollable Conversation panel above a sticky composer, so long feedback queues do not push the text box or send controls off screen.
  The browser chrome keeps editing actions in the overflow menu (copy path, reload artifact, export standalone HTML, end session), while the composer exposes **Send & End** beside **Send to Agent** to submit queued prompts and user-ended attribution together.
- **Keyboard shortcuts** - In the chrome composer, Enter sends queued prompts and Shift+Enter inserts a newline.
  In the annotation card, Enter queues the annotation and Shift+Enter inserts a newline.
  Cmd+I or Ctrl+I toggles between annotate and explore mode from either the browser chrome or the artifact iframe, including while focus is in a textarea or control.
  A session opens in explore mode, so the artifact behaves like an ordinary page until you turn **Annotate** on with the toolbar switch or that shortcut.
- **Agent presence** - The browser shows when no agent is listening, keeps queued feedback and proven severe layout failures for the next successful `luxe poll` send even across reloads, and only blocks human sends while the agent is working on delivered feedback; the agent's reply (`--agent-reply`) concludes that work and re-enables sends.
  The no-timeout poll always writes an immediate stderr banner so it is visibly not hung; it adds the periodic stderr wait ticks only in an interactive terminal, so when stderr is piped (as under agent harnesses) the captured output carries no tick noise. Stdout always stays reserved for the final response; if the poll is interrupted or times out, re-run it because queued feedback is never lost.
  Codex-specific guidance keeps that poll attached to the active turn instead of hiding it in a background task, because completed background tasks may not resume the agent.
- **Session end etiquette** - Luxe tracks who ended a session: a human clicking **End session** (or **Send & end session**) in the browser is a user-initiated end, while `luxe end <html-file>` is agent-initiated.
  A plain `luxe <html-file>` after a user-initiated end refuses to reopen the browser and returns guidance instead; pass `--reopen` only when the user asks for further review or something important needs their visual attention.
  Agent-initiated ends keep reopening normally, same as before.
  `luxe poll`'s `ended` response and the `feedback` response for the final batch before an end both carry `next_step` guidance telling the agent to stop polling and deliver remaining updates in chat instead of reopening.
- **Precise targets** - Text annotations include selected text plus range anchors, so agents are not limited to whole-element selectors.
- **Mermaid diagrams** - In the Luxe browser, every rendered Mermaid diagram in a `.mermaid` container becomes an embedded editable Excalidraw whiteboard.
  Click a diagram to unlock editing, and use its Fullscreen action to edit it over the whole viewport.
  Whiteboard scenes autosave locally.
  If a live reload changes the Mermaid source, the whiteboard shows that its edits are stale; reopening it lets the reviewer re-convert and discard the saved edits or keep editing the saved scene.
  Use **Queue feedback** to add a bounded edit summary plus local `.excalidraw` scene and PNG preview paths to the Conversation panel, then click **Send to Agent** to deliver it.
  The agent updates the artifact's Mermaid source, which remains authoritative.
  Flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other diagram types are images that reviewers can draw and annotate.
  Luxe changes only the browser view, so saved, standalone, and exported artifacts still render plain Mermaid.
- **Server cleanup** - The detached server stops after the last session ends when nothing is connected, or after `LUXE_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser or poll connections.
  Set `LUXE_IDLE_TIMEOUT_MS=0` or `off` to disable idle self-shutdown.
- **What a Send includes** - Every Send delivers a `dom_snapshot` alongside your prompts: a text outline of the artifact as it is currently rendered, so the agent has page context for the feedback.
  It captures visible rendered text, including anything sensitive shown in a table, code block, or config listing, up to 2,000 nodes and 128 KiB.
  A capped snapshot ends with `[Luxe DOM snapshot truncated]`, and the snapshot is stored in the local state file until the agent's next poll collects it.
- **Trust model** - Artifact JavaScript may queue feedback through the documented `window.luxe` API, but only chrome-owned **Send to Agent**, **Send & End**, or **End session** gestures may transmit feedback or end browser review.
  In-page questions and forms fill the queue, then the reviewer confirms the action from the Luxe chrome.
  Luxe's guards stop a foreign page from driving your session; they do not sandbox an artifact against its own author, so do not open artifacts from a source you would not let write code for you.
- **Local-first state** - Session state stays under `~/.luxe/` by default, or `LUXE_STATE_DIR` when set.
  The state directory and the whiteboard sidecar directories under it are owner-only (`0700`), and `state.json` and `server.log` are written `0600`, because between them they hold every project's prompts, chat history, DOM snapshots, and artifact paths in one place. Those four things are re-tightened to those modes at every CLI start, so anything an older version created or a stray `chmod` loosened is fixed on the next run; whiteboard scene files keep the default mode and are protected by their `0700` parents. Windows keeps its own filesystem defaults.
- **Server port** - Set `LUXE_PORT` to choose the server port; it defaults to `4387`.
- **Network binding** - The server binds to loopback (`127.0.0.1`) by default. Set `LUXE_HOST` to bind elsewhere; a wildcard (`0.0.0.0` or `::`) binds every interface. Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. Set `LUXE_LINK_HOST` to control the hostname written into generated session links (defaults to the bind address, or loopback when bound to a wildcard).
- **Allowed hosts** - To defend against DNS rebinding, the server rejects (`403`) any request whose `Host` header is missing or not one it answers to: the loopback names (`127.0.0.1`, `::1`, `localhost`) plus the configured bind and link host. If you reach the server under another name - a wildcard bind accessed by LAN IP, a reverse-proxy hostname, or an extra interface - list those names in `LUXE_ALLOWED_HOSTS` (whitespace-separated) to allow them. Behind a reverse proxy, the forwarded `X-Forwarded-Host` is validated against the same list, so add your public hostname there and have the proxy send it. Set `LUXE_ALLOWED_HOSTS` to `*` to disable the check entirely (only when the server sits behind your own authentication or proxy).
- **Framing and cross-origin writes** - The session page refuses to be framed at all (`X-Frame-Options: DENY` and `frame-ancestors 'none'`), and artifact routes allow only same-origin framing (`frame-ancestors 'self'`) so Luxe's own chrome can host the artifact iframe. No other CSP is applied to artifact content, so artifacts render exactly as authored.
  State-changing routes - `/shutdown`, `/api/sessions`, `/api/poll`, `/api/end`, `/api/:key/end`, `/api/:key/prompts`, `/api/:key/agent-reply`, `/api/:key/layout-warnings`, and the whiteboard writes - reject (`403`) any request a browser attached a foreign `Origin` or `Referer` to, including the `Origin: null` a sandboxed iframe sends.
  Requests with no browser provenance at all are accepted on those routes because that is how the CLI reaches them; the whiteboard writes, which only the browser ever calls, reject those too.
- **Browser opening** - Set `LUXE_NO_OPEN=1`, equivalent to `--no-open`, to create or resume a session without launching a browser window.

## CLI Reference

| Command                   | Description                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `luxe`                    | Show current sessions and usage guidance.                                                                                                                                                                                                                                                      |
| `luxe update`             | Check for or apply the latest npm release through the AXI SDK self-updater.                                                                                                                                                                                                                    |
| `luxe <html-file>`        | Open or resume a Luxe Editor session, with the open-time layout gate enabled by default. Refuses to reopen a session the user explicitly ended from the browser unless `--reopen` is passed.                                                                                                   |
| `luxe poll <html-file>`   | Long-poll until the user sends feedback, ends the session, or the browser proves a severe layout failure; leave no-timeout polls running, or re-run them if interrupted. Codex guidance keeps polls attached to the active turn. On `status: ended`, stop polling and do not reopen uninvited. |
| `luxe end <html-file>`    | End a session as the agent; unlike a user-initiated end from the browser, this still allows a plain reopen later.                                                                                                                                                                              |
| `luxe export <html-file>` | Write a portable copy of the artifact: one HTML file with its local assets inlined, so it opens with no server and no sibling files. Remote CDN/font references are left as links.                                                                                                             |
| `luxe stop`               | Shut down the background server.                                                                                                                                                                                                                                                               |
| `luxe playbook [id]`      | List focused artifact guidance or show one playbook; agents must open each matching playbook before writing HTML.                                                                                                                                                                              |
| `luxe design`             | Show agent-facing design guidance, including optional CDN and Mermaid snippets.                                                                                                                                                                                                                |
| `luxe server`             | Run the local Luxe Editor server.                                                                                                                                                                                                                                                              |

Known playbook IDs: `diagram`, `table`, `comparison`, `plan`, `code`, `input`.
One artifact often combines several playbooks, such as a plan that includes a comparison and a diagram, so agents must match against each `use_when` trigger and open every matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, open the diagram playbook for the recommended tooling and SVG guidance.

### Flags

| Command            | Flag                  | Description                                                                                                                                                                                                       |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `luxe <html-file>` | `--no-open`           | Ensure the server/session exists without opening another browser window.                                                                                                                                          |
| `luxe <html-file>` | `--no-gate`           | Skip the open-time layout curtain for this browser open.                                                                                                                                                          |
| `luxe <html-file>` | `--reopen`            | Reopen a session the user explicitly ended from the browser; without it, a plain open refuses and explains why instead of reopening uninvited.                                                                    |
| `luxe update`      | `--check`             | Report current vs latest npm version without installing an update.                                                                                                                                                |
| `luxe export`      | `--out <path>`        | Write the export to a specific path instead of `<name>.export.html` next to the source.                                                                                                                           |
| `luxe poll`        | `--agent-reply "..."` | Show the agent's reply in the existing browser chat and re-enable human sends before polling again.                                                                                                               |
| `luxe poll`        | `--timeout-ms <ms>`   | Test/debug escape hatch only; agents should normally omit it and leave the long poll running.                                                                                                                     |
| `luxe stop`        | `--port <port>`       | Shut down a server running on a non-default port.                                                                                                                                                                 |
| `luxe server`      | `--verbose`           | Log session and watcher events to stderr; can also be enabled with `LUXE_DEBUG=1`. Detached server output is appended to `~/.luxe/server.log` (or `LUXE_STATE_DIR/server.log`) for startup and crash diagnostics. |

## Development

```sh
npm run check          # Run all verification commands
npm run build          # Bundle the publishable CLI, chrome, and design assets
npm run build:skill    # Regenerate the installable luxe skill
npm test               # Run node:test tests
npm run lint           # Run ESLint
npm run format:check   # Check Prettier formatting
npm run typecheck      # Run TypeScript checkJs validation
npm run naming         # Check that no upstream identifiers leaked in
```
