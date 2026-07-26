# Mermaid 11.12.1 risk acceptance

Status: accepted for the current release candidate on 2026-07-26.

Luxe ships Mermaid inside `dist/whiteboard/whiteboard.js` through the exactly pinned `@excalidraw/mermaid-to-excalidraw@2.2.2` converter.
This is bundled browser code, so the development-only manifest classification does not remove its release risk.

## Decision

Retain `mermaid@11.12.1` until a tested converter release supports the patched Mermaid line without degrading editable diagrams to image fallbacks.
This is a temporary compatibility risk acceptance, not a claim that the advisories are unreachable.

The accepted Mermaid advisories are:

- `GHSA-87f9-hvmw-gh4p` - improper configuration sanitization can lead to CSS injection.
- `GHSA-ghcm-xqfw-q4vr` - state diagram `classDef` sanitization can lead to HTML injection.
- `GHSA-xcj9-5m2h-648r` - diagram `classDefs` sanitization can lead to CSS injection.
- `GHSA-6m6c-36f7-fhxh` - crafted Gantt charts can trigger an infinite-loop denial of service.

The same bundled dependency graph contains `lodash-es@4.17.21`, affected by:

- `GHSA-r5fr-rjxr-66jc` - code injection through `_.template` import key names.

The vulnerable Lodash template implementation is currently tree-shaken out of `dist/whiteboard/whiteboard.js`.
The build regression checks that its identifying symbols remain absent, but this reduces only the observed Lodash reachability and does not resolve the Mermaid advisories.

## Bounded upgrade attempts

Attempt 1 paired the released `@excalidraw/mermaid-to-excalidraw@2.2.2` with exact `mermaid@11.16.0`.
The build completed, but the real-browser regression degraded the existing flowchart to an image fallback with no editable text labels.

Attempt 2 pinned upstream compatibility work from converter pull request 106 at commit `21f5d11bcf7f2f724909c8e9ecb1ea6b1b457526`.
That commit targets Mermaid 11.15 and later, but its Git dependency contains no built `dist` entry point, so the Luxe whiteboard bundle could not resolve the package.
Shipping an unmerged source snapshot or a locally fabricated package would expand the supply-chain and maintenance risk beyond this dependency update.

Both attempts were reverted completely.
The retained pair is `@excalidraw/mermaid-to-excalidraw@2.2.2` with `mermaid@11.12.1`.

## Compensating controls and review trigger

The whiteboard runs in its dedicated sandboxed iframe, and Luxe opens Mermaid source from a local artifact explicitly selected by the user.
Real-browser tests require flowchart subgraphs plus class, ER, and state diagrams to produce native editable elements rather than all-image scenes.
These controls limit exposure and compatibility drift, but they do not patch malicious Mermaid input.

Reopen this decision when the converter publishes a release that supports Mermaid 11.15 or later, or when its current compatibility work is merged and released.
The replacement must pass the native-conversion matrix, loaded-font geometry checks, whiteboard conversion regressions, and the full repository gate before this acceptance is removed.
