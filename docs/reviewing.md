# Reviewing artifacts

What happens on the human side of the loop, once `luxe <html-file>` has opened the browser.

## Annotate and explore mode

A session opens in explore mode, so the artifact behaves like an ordinary page until you turn **Annotate** on with the toolbar switch or the keyboard shortcut.

Text annotations include the selected text plus range anchors, so agents are not limited to whole-element selectors.

## Keyboard shortcuts

| Where           | Key             | Does                                     |
| --------------- | --------------- | ---------------------------------------- |
| Chrome composer | Enter           | Send queued prompts                      |
| Chrome composer | Shift+Enter     | Insert a newline                         |
| Annotation card | Enter           | Queue the annotation                     |
| Annotation card | Shift+Enter     | Insert a newline                         |
| Anywhere        | Cmd+I or Ctrl+I | Toggle between annotate and explore mode |

Cmd+I and Ctrl+I work from either the browser chrome or the artifact iframe, including while focus is in a textarea or control.

## Feedback controls

Native controls (radios, checkboxes, inputs, selects, buttons, labels, disclosure summaries, contenteditable) are interactive automatically, so they do not need `data-luxe-action`.

For reversible choices, let option clicks update local state, then queue exactly one final answer from a per-question submit or Queue answer button with `window.luxe.queuePrompt()`.
In-page forms fill the Conversation queue, and the reviewer confirms transmission from the chrome with **Send to Agent** or **Send & End**.

Mark only custom (non-native) clickable elements with `data-luxe-action` so Luxe does not annotate them.
Use `data-luxe-question` or `queueKey` when pre-send updates for the same question should replace each other.

Queued annotation preview pills and chat history share a scrollable Conversation panel above a sticky composer, so long feedback queues do not push the text box or send controls off screen.

The browser chrome keeps editing actions in the overflow menu (copy path, reload artifact, export standalone HTML, end session), while the composer exposes **Send & End** beside **Send to Agent** to submit queued prompts and user-ended attribution together.

## What a Send includes

Every Send delivers a `dom_snapshot` alongside your prompts: a text outline of the artifact as it is currently rendered, so the agent has page context for the feedback.

It captures visible rendered text, including anything sensitive shown in a table, code block, or config listing, up to 2,000 nodes and 128 KiB.
A capped snapshot ends with `[Luxe DOM snapshot truncated]`, and the snapshot is stored in the local state file until the agent's next poll collects it.

See [Security](security.md) for what that means for artifacts holding sensitive values.

## Live reload

Luxe watches the HTML artifact file by default and preserves the artifact iframe scroll position across reloads.
To also reload on sibling asset changes, add `data-luxe-live-reload-root` to the root element or `<meta name="luxe-live-reload" content="root">`.

## Mermaid diagrams as whiteboards

In the Luxe browser, every rendered Mermaid diagram in a `.mermaid` container becomes an embedded editable Excalidraw whiteboard.

Click a diagram to unlock editing, and use its Fullscreen action to edit it over the whole viewport.
Whiteboard scenes autosave locally.

If a live reload changes the Mermaid source, the whiteboard shows that its edits are stale.
Reopening it lets the reviewer re-convert and discard the saved edits, or keep editing the saved scene.

Use **Queue feedback** to add a bounded edit summary plus local `.excalidraw` scene and PNG preview paths to the Conversation panel, then click **Send to Agent** to deliver it.
The agent updates the artifact's Mermaid source, which remains authoritative.

Flowchart, sequence, class, ER, and state diagrams convert to editable shapes.
Other diagram types are images that reviewers can draw on and annotate.

Luxe changes only the browser view, so saved, standalone, and exported artifacts still render plain Mermaid.

Scenes are ephemeral.
Every scene is deleted when the session ends, when the idle server shuts down, or by the sweep at the next server start, so a whiteboard can be collected even if you never end the session.

Keeping one is explicit: press **Save to machine** in the whiteboard, or have the agent run [`luxe save-diagram`](cli.md).
That writes `<artifact-basename>.wb<n>.excalidraw` next to the artifact, plus the PNG the browser last exported if there is one, and exempts the scene from cleanup.

## Agent presence

The browser shows when no agent is listening.
It keeps queued feedback and proven severe layout failures for the next successful `luxe poll` send even across reloads, and only blocks human sends while the agent is working on delivered feedback.
The agent's reply (`--agent-reply`) concludes that work and re-enables sends.

The no-timeout poll always writes an immediate stderr banner so it is visibly not hung.
It adds the periodic stderr wait ticks only in an interactive terminal, so when stderr is piped (as under agent harnesses) the captured output carries no tick noise.
Stdout always stays reserved for the final response.
If the poll is interrupted or times out, re-run it, because queued feedback is never lost.

Codex-specific guidance keeps that poll attached to the active turn instead of hiding it in a background task, because completed background tasks may not resume the agent.

## Session end etiquette

Luxe tracks who ended a session.
A human clicking **End session** (or **Send & end session**) in the browser is a user-initiated end, while `luxe end <html-file>` is agent-initiated.

A plain `luxe <html-file>` after a user-initiated end refuses to reopen the browser and returns guidance instead.
Agents should pass `--reopen` only when the user asks for further review, or when something important needs their visual attention.
Agent-initiated ends keep reopening normally.

`luxe poll`'s `ended` response, and the `feedback` response for the final batch before an end, both carry `next_step` guidance telling the agent to stop polling and deliver remaining updates in chat instead of reopening.
