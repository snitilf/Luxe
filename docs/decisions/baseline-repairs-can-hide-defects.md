# The artifact baseline can trade a visible defect for an invisible one

Status: accepted on 2026-07-29, with the layout audit tightened rather than the repair removed.

Luxe injects `src/artifact-baseline.css` into every artifact.
It is deliberately repairs-only and zero-specificity, so an author's own CSS always wins.
One of those repairs is `:where(.grid, .flex) > * { min-width: 0 }`, which fixes the classic trap where a grid or flex child refuses to shrink below its content and forces the page to scroll sideways.

That repair is correct and is staying.
This records a consequence of it that is not obvious, because it was found by accident and will be found again otherwise.

## What happens

On a narrow viewport, removing the overflow does not always make the layout good.
It can make the layout _differently_ broken.

Measured on `test/fixtures/layout-audit/control-broken-overflow.html` at a 390px artifact viewport:

- Without the repair, page overflow is 252px.
  The page scrolls sideways.
  Every element is still reachable and readable.
- With the repair, page overflow is 12px, under the audit's 24px materiality threshold.
  Instead, a badge is painted over by an opaque sibling card and is completely invisible.

The first state is ugly and recoverable.
The second loses content outright.
The repair moved the artifact from the first to the second, and for a long time the audit reported neither.

## Why this is easy to miss

The overflow is the loud symptom, and the repair removes it.
Nothing about the repair announces that the content it stopped pushing off-screen is now underneath something else.

It also broke a test fixture without failing anything.
`control-broken-overflow.html` existed to exhibit the unshrinkable-child defect.
Once the baseline repaired that defect, the fixture stopped testing anything, and nobody noticed because the browser suite that used it was gated behind an environment variable that CI never set.

## Decision

Keep the repair. Tighten the audit instead.

A repair that resolves a real defect is worth having even when it exposes a second one, because the second defect was already present in the markup.
The correct response is for the audit to report it, not for Luxe to leave pages overflowing.

Accordingly:

- `isOccludableAuditText` now admits any label of two or more grapheme clusters, or any interactive control.
  Previously the occlusion check required eight characters, which left the audit stricter about content that vanishes entirely than about content merely clipped.
- `control-broken-overflow.html` carries a second defect the baseline cannot repair, so its overflow assertion stays meaningful.
- The real-browser suites now run in CI through `npm run check:browser`, so a fixture that stops exercising its defect fails instead of passing quietly.

## What this does not fix

The audit reports occlusion of text.
A repair that hides a non-text element, or that changes meaning without changing geometry, is still invisible to it.

Any future baseline rule should be reviewed for the same shape: does this remove a symptom while leaving the underlying layout problem in place, in a form the audit cannot see?
If the answer is yes, the audit needs to learn the new shape before the rule ships.
