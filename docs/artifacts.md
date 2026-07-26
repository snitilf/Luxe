# Writing artifacts

What an agent needs to know to produce an HTML artifact that works well in Luxe.

## File-path identity

Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.

## Portable artifacts

The artifact runs in an iframe while Luxe injects a small SDK for annotations, snapshots, feedback controls, and render-time layout checks.

Luxe does not inject any design system, so the saved HTML file renders identically whether you open it through `luxe` or directly in a browser.

Run `luxe design` for the single source of agent-facing design guidance and optional CDN or Mermaid snippets.

## Local assets

Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory.
Root-prefixed paths such as `/assets/logo.png` will not resolve through Luxe's artifact route.

## Open-time layout gate

The browser chrome masks an artifact only while the real in-iframe audit checks for a stable, proven severe layout failure.

A severe failure notifies the agent through the `layout_warnings` poll path and keeps the curtain up until a clean reload, while cosmetic, intentional, transient, tiny, and uncertain observations stay silent.

The user can click **Show anyway**, and a bounded safety timeout fails open without an issue banner when no severe failure has been proven.

Pass `--no-gate` to skip the curtain for one browser open.

## Layout failures

After fonts and finite animations settle, the injected SDK confirms severe failures from direct rendered evidence such as materially escaped meaningful content or required controls, clipped text fragments, viewport reachability, or near-total semantic occlusion.

Explicit ellipsis and line clamp, standard visually hidden accessibility text, intentional scrollers or masks, parent overhang, generic element scroll geometry, decorative overlap, and uncertain motion do not produce findings by themselves.

Proven failures are returned from `luxe poll` in `layout_warnings` with `selector`, `kind`, `axis`, `overflowPx`, `viewportWidth`, `severity`, and `persistent`.

Every returned failure should be fixed and rechecked before asking the human to review.

## Export

`luxe export` writes `<name>.export.html` by inlining local assets only, stripping the annotation SDK, and leaving remote CDN and font references as links that still need network access.

Bundling never fetches remote URLs, Luxe itself does not set a CSP, local reads stay confined and size-capped, and absolute `file://` paths outside safe inlined asset references are redacted before output.

Per-asset and per-bundle inline caps default to 10 MB and 25 MB, overridable with `LUXE_EXPORT_MAX_ASSET_BYTES` and `LUXE_EXPORT_MAX_BUNDLE_BYTES`.
See [Configuration](configuration.md).

Unresolved local assets, or export notices such as author-set CSP meta tags and redacted file URLs, are surfaced in command or browser output.
