# Configuration

Every environment variable you set to change how Luxe behaves.

| Variable                       | Default                                                | Does                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LUXE_PORT`                    | `4387`                                                 | The server port.                                                                                                                                                            |
| `LUXE_HOST`                    | `127.0.0.1`                                            | The bind address. Any non-loopback value, including a wildcard (`0.0.0.0` or `::`), also requires `LUXE_ALLOW_REMOTE=1`. See [Security](security.md) before changing this.  |
| `LUXE_ALLOW_REMOTE`            | unset                                                  | Set to exactly `1` to acknowledge the exposure and permit a non-loopback `LUXE_HOST`. Without it the server refuses to start. See [Security](security.md).                  |
| `LUXE_LINK_HOST`               | The bind address, or loopback when bound to a wildcard | The hostname written into generated session links.                                                                                                                          |
| `LUXE_ALLOWED_HOSTS`           | Loopback names plus the bind and link host             | Whitespace-separated extra `Host` values the server will answer to. `*` disables the check entirely. This never satisfies `LUXE_ALLOW_REMOTE`. See [Security](security.md). |
| `LUXE_STATE_DIR`               | `~/.luxe/`                                             | Where session state, the server log, and whiteboard scenes are kept.                                                                                                        |
| `LUXE_IDLE_TIMEOUT_MS`         | 30 minutes                                             | How long the detached server stays up with no browser or poll connections. `0` or `off` disables idle self-shutdown.                                                        |
| `LUXE_NO_OPEN`                 | unset                                                  | Set to `1`, equivalent to `--no-open`, to create or resume a session without launching a browser window.                                                                    |
| `LUXE_DEBUG`                   | unset                                                  | Set to `1`, equivalent to `luxe server --verbose`, to log session and watcher events to stderr.                                                                             |
| `LUXE_EXPORT_MAX_ASSET_BYTES`  | 10 MB                                                  | Per-asset inline cap for `luxe export`.                                                                                                                                     |
| `LUXE_EXPORT_MAX_BUNDLE_BYTES` | 25 MB                                                  | Per-bundle inline cap for `luxe export`.                                                                                                                                    |

This is the list of variables you set.
Luxe also reads a few it sets or detects for itself, such as the build-time version stamp and the harness variables it uses to recognize a Codex sandbox; those are not configuration.

## Server cleanup

The detached server stops after the last session ends when nothing is connected, or after `LUXE_IDLE_TIMEOUT_MS` with no browser or poll connections.

Detached server output is appended to `~/.luxe/server.log`, or `LUXE_STATE_DIR/server.log` when set, for startup and crash diagnostics.
