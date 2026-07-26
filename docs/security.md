# Security

## Trust model

Artifact JavaScript may queue feedback through the documented `window.luxe` API, but only chrome-owned **Send to Agent**, **Send & End**, or **End session** gestures may transmit feedback or end browser review.

In-page questions and forms fill the queue, and the reviewer then confirms the action from the Luxe chrome.

Luxe's guards stop a foreign page from driving your session.
They do not sandbox an artifact against its own author, so do not open artifacts from a source you would not let write code for you.

## What is stored on disk

Session state stays under `~/.luxe/` by default, or `LUXE_STATE_DIR` when set.

The state directory and the whiteboard sidecar directories under it are owner-only (`0700`), and `state.json` and `server.log` are written `0600`, because between them they hold every project's prompts, chat history, DOM snapshots, and artifact paths in one place.

Those four things are re-tightened to those modes at every CLI start, so anything an older version created or a stray `chmod` loosened is fixed on the next run.
Whiteboard scene files keep the default mode and are protected by their `0700` parents.
Windows keeps its own filesystem defaults.

## What a Send transmits

Every Send delivers a `dom_snapshot` of the artifact as currently rendered.
It captures visible rendered text, including anything sensitive shown in a table, code block, or config listing, up to 2,000 nodes and 128 KiB.
The snapshot is stored in the local state file until the agent's next poll collects it.

If an artifact displays a secret, that secret is in the snapshot.
See [Reviewing artifacts](reviewing.md) for the full description.

## Network binding

The server binds to loopback (`127.0.0.1`) by default.

Set `LUXE_HOST` to bind elsewhere; a wildcard (`0.0.0.0` or `::`) binds every interface.
Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network.

Set `LUXE_LINK_HOST` to control the hostname written into generated session links.
It defaults to the bind address, or loopback when bound to a wildcard.

## Allowed hosts

To defend against DNS rebinding, the server rejects (`403`) any request whose `Host` header is missing or not one it answers to: the loopback names (`127.0.0.1`, `::1`, `localhost`) plus the configured bind and link host.

If you reach the server under another name, such as a wildcard bind accessed by LAN IP, a reverse-proxy hostname, or an extra interface, list those names in `LUXE_ALLOWED_HOSTS` (whitespace-separated) to allow them.

Behind a reverse proxy, the forwarded `X-Forwarded-Host` is validated against the same list, so add your public hostname there and have the proxy send it.

Set `LUXE_ALLOWED_HOSTS` to `*` to disable the check entirely, and only when the server sits behind your own authentication or proxy.

## Framing and cross-origin writes

The session page refuses to be framed at all (`X-Frame-Options: DENY` and `frame-ancestors 'none'`), and artifact routes allow only same-origin framing (`frame-ancestors 'self'`) so Luxe's own chrome can host the artifact iframe.
No other CSP is applied to artifact content, so artifacts render exactly as authored.

State-changing routes reject (`403`) any request a browser attached a foreign `Origin` or `Referer` to, including the `Origin: null` a sandboxed iframe sends.
Those routes are `/shutdown`, `/api/sessions`, `/api/poll`, `/api/end`, `/api/:key/end`, `/api/:key/prompts`, `/api/:key/agent-reply`, `/api/:key/layout-warnings`, and the whiteboard writes.

Requests with no browser provenance at all are accepted on those routes, because that is how the CLI reaches them.
The whiteboard writes, which only the browser ever calls, reject those too.

## Dependencies

Mermaid is pinned at 11.12.1 under a recorded risk acceptance.
See [`security/mermaid-11.12-risk-acceptance.md`](security/mermaid-11.12-risk-acceptance.md).
