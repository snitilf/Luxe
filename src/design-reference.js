import { luxeShikiThemeJson } from "./luxe-shiki-theme.js";
import { luxeMermaidInitLiteral } from "./mermaid-theme.js";
import { listPlaybooks, PLAYBOOK_ROUTER_INSTRUCTION } from "./playbooks.js";

export const TAILWIND_BROWSER_VERSION = "4.2.4";
export const DAISYUI_VERSION = "5.5.19";
export const MERMAID_VERSION = "11.15.0";

export const DESIGN_CDN_URLS = {
  tailwind: `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@${TAILWIND_BROWSER_VERSION}/dist/index.global.js`,
  daisyui: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/daisyui.css`,
  daisyuiThemes: `https://cdn.jsdelivr.net/npm/daisyui@${DAISYUI_VERSION}/themes.css`,
};

export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;

// Subresource Integrity for every CDN file this guidance tells agents to load. Artifacts are
// authored by an agent and reviewed by a human who is not reading the network tab, so a
// compromised or hijacked CDN response would execute unnoticed inside the artifact. Each hash
// is the SHA-384 of the exact pinned file above, so the version constants and these digests
// must be changed together - bumping a version without recomputing its hash makes the browser
// refuse to load the file (which fails loudly, not silently, and is the safe direction).
//
// Recompute with:
//   curl -sSL <url> | openssl dgst -sha384 -binary | openssl base64 -A
export const DESIGN_CDN_INTEGRITY = {
  tailwind: "sha384-v5YF9xS+gLRWdvrQ0u/WRbCkjSIH0NjHIPe8tBL1ZRrmI7PiSH6LLdzs0aAIMCuh",
  daisyui: "sha384-/NNZlK8J6WoD6FfmmLzhqE1x/aTnlIJzc75uc+dFz8aI+/sD2ArUirQhs3hbeqBe",
  daisyuiThemes: "sha384-ai6dM6tUdx0lUGOHd8x3eGevvDdj0p+CPoJp7Ve+h+kRkt08XtqX/g3a+1cPYKCm",
};

export const MERMAID_CDN_INTEGRITY = "sha384-whY2DyvhZRFfs9hvtGdZaKcgbETgqMlDN+KNlWnXEL2QDa2XQkBOApUT7arfftO9";

export const DESIGN_CDN_SNIPPET = `<link rel="stylesheet" href="${DESIGN_CDN_URLS.daisyui}" integrity="${DESIGN_CDN_INTEGRITY.daisyui}" crossorigin="anonymous">
<link rel="stylesheet" href="${DESIGN_CDN_URLS.daisyuiThemes}" integrity="${DESIGN_CDN_INTEGRITY.daisyuiThemes}" crossorigin="anonymous">
<script src="${DESIGN_CDN_URLS.tailwind}" integrity="${DESIGN_CDN_INTEGRITY.tailwind}" crossorigin="anonymous"></script>`;

// An ES module import takes no integrity attribute, so Mermaid's digest is declared through
// an import map's `integrity` key instead. The import below still names the full URL rather
// than a bare specifier on purpose: where the import map is honoured the browser enforces the
// hash, and where it is not (older browsers, or a page that already installed an import map)
// the module still loads exactly as before. Integrity covers the entry module only; Mermaid
// loads further chunks by relative URL and those are not hashed here.
//
// Luxe is light-only, so this snippet renders once with a fixed theme. Upstream shipped a
// page-background probe, a `prefers-color-scheme` listener and a MutationObserver here to keep
// diagrams in step with a theme that could flip; none of that has a reason to exist any more,
// and it is deleted rather than retuned (UI-REVAMP section 5, cleanup 2). The `themeVariables`
// block below is imported from `src/mermaid-theme.js`, never restated, and is what stops Mermaid
// falling back to its own beige-and-purple defaults.
export const MERMAID_CDN_SNIPPET = `<script type="importmap">
  { "integrity": { "${MERMAID_CDN_URL}": "${MERMAID_CDN_INTEGRITY}" } }
</script>
<script type="module">
  import mermaid from "${MERMAID_CDN_URL}";

  mermaid.initialize(${luxeMermaidInitLiteral("  ")});

  const diagrams = [...document.querySelectorAll(".mermaid")];
  async function render() {
    if (diagrams.length === 0) return;
    try {
      await mermaid.run({ nodes: diagrams });
    } catch (error) {
      console.error("Mermaid diagram render failed:", error);
    }
  }

  // Render once stylesheets are applied, so the fonts the theme names are the
  // ones Mermaid measures against.
  if (document.readyState === "complete") void render();
  else window.addEventListener("load", () => void render(), { once: true });
</script>`;

// D1: one Luxe theme block mapping DaisyUI's semantic variables onto the Luxe tokens. The
// upstream DaisyUI catalogue and build stay intact - this replaces the theme *choice*, not
// the component reference. Values are the tokens in `src/luxe-tokens.css`.
//
// Two deliberate remappings:
//   - Luxe's surface planes get LIGHTER as they rise, the opposite of DaisyUI's convention, so
//     `base-100` is the white card plane, `base-200` the raised panel, `base-300` the page
//     canvas, and `body` is pinned to the canvas explicitly.
//   - `accent` is a second cocoa, not the Luxe gold. The gold is reserved for the annotation
//     stroke and the selected-text wash; leaving it reachable through `btn-accent` would spend
//     the one accent hue on ordinary buttons.
export const LUXE_DAISYUI_THEME_CSS = `<style>
  :root, [data-theme="luxe"] {
    color-scheme: light;

    --color-base-100: #ffffff;
    --color-base-200: #fbf9f4;
    --color-base-300: #f7f4ee;
    --color-base-content: #211e17;

    --color-primary: #463527;
    --color-primary-content: #f7f4ee;
    --color-secondary: #5c564a;
    --color-secondary-content: #f7f4ee;
    --color-accent: #57432f;
    --color-accent-content: #f7f4ee;
    --color-neutral: #211e17;
    --color-neutral-content: #f7f4ee;

    --color-info: #3c5f8f;
    --color-info-content: #f7f4ee;
    --color-success: #2e6b27;
    --color-success-content: #f7f4ee;
    --color-warning: #8a5a06;
    --color-warning-content: #f7f4ee;
    --color-error: #b3341f;
    --color-error-content: #f7f4ee;

    --radius-selector: 999px;
    --radius-field: 8px;
    --radius-box: 16px;
    --size-selector: 0.25rem;
    --size-field: 0.25rem;
    --border: 1px;
    --depth: 0;
    --noise: 0;
  }

  html, body {
    background: #f7f4ee;
    color: #211e17;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    letter-spacing: -0.15px;
  }

  /* The heading face. Served from Luxe's own /fonts route, which is same-origin for an
     artifact under review and is inlined into a standalone export by resolveExportAssetPath.
     An artifact opened straight off disk with no Luxe around simply falls back to Georgia -
     font-display: swap means that costs nothing and shows nothing broken. */
  @font-face {
    font-family: "Newsreader";
    font-style: normal;
    font-weight: 500;
    font-display: swap;
    src: url("/fonts/newsreader-latin-500-normal.woff2") format("woff2");
  }

  h1, h2, h3 {
    font-family: "Newsreader", Georgia, "Times New Roman", serif;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  code, pre, kbd, samp {
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0;
  }

  pre, .mockup-code {
    background: #f7f4ec;
    border: 1px solid #e7e2d6;
    border-radius: 12px;
  }
</style>`;

// Single source for how agents choose an artifact's design direction. It flows into the
// no-args home output, top-level --help, the generated skill (all via DESIGN_SYSTEM_HINT),
// the `luxe design` summary, and the design command help. Edit the rule here only;
// other surfaces embed it or point at it instead of restating it.
export const DESIGN_PRIORITY_RULE =
  "Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Luxe-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user.";

export const DESIGN_SYSTEM_HINT =
  "Luxe does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without luxe running. Before writing any HTML: " +
  DESIGN_PRIORITY_RULE +
  " Run `luxe design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When you deliver the artifact, state which of the three design sources you used and why.";

// Charts have no playbook of their own, because this product ships no chart components. The
// palette rules still have to reach whoever authors one, so they live here and surface through
// `luxe design`. The labelling rule is load-bearing rather than stylistic: three of the eight
// slots sit below 3:1 on the Luxe canvas, so an unlabelled series is genuinely hard to read.
export const LUXE_CHART_GUIDANCE = Object.freeze({
  labelling_rule:
    "Every chart MUST carry direct labels, printed values, or an accompanying table view. A legend alone is not sufficient. Two of the eight palette slots (the eucalyptus and the amber) sit below the 3:1 contrast floor on the Luxe canvas, so a legend-only chart makes those series unreadable rather than merely inelegant.",
  palette: ["#5b85cc", "#874420", "#4bad8e", "#cf8b3b", "#677d12", "#be5b7f", "#73488e", "#9f4f36"],
  palette_rules: [
    "Fixed order, never cycled and never reshuffled: the order is the colour-blind safety mechanism, not decoration. It also means an N-series chart uses exactly slots 1..N, so take them from the top - never pick slot 6 for a two-series chart.",
    "The set stays mutually distinguishable through slot 7 for full-colour vision and slot 5 for colour-blind readers. Past that, the labelling rule below is what carries the chart, and it stops being optional.",
    "Lines, stacked bars, and grouped bars may use all eight slots. Scatter, bubble, choropleth, and small multiples cap at four.",
    "A series that itself means good or bad wears the status colours, not a categorical slot.",
    "The palette is measured against the paper canvas, so draw charts on the canvas, on a white card, or on their own light plane. Do not draw one directly onto a cocoa fill: the slots are mid-tones chosen to hold contrast against a light surface, and no eight-hue palette can clear 3:1 against both the paper and the cocoa at once. A chart inside a cocoa panel gets its own paper-coloured plate.",
  ],
  marks:
    "2px strokes, round caps and joins, 4px end dots ringed 2px in the canvas colour, gridlines in #e7e2d6, axis text #5c564a at 14px, 2px surface gap between stacked segments.",
  sequential: ["#7c9edd", "#6283bf", "#4868a2", "#304e86", "#19356b"],
  diverging: ["#234993", "#4d70b2", "#8199c4", "#e9e5da", "#bf8a78", "#a7593f", "#852b06"],
});

/**
 * @param {{ artifactBaselineSnippet?: string }} [options] the baseline stylesheet as a
 * `<style>` block. Passed in rather than read here so this module stays synchronous and
 * free of file access, and so there is still exactly one copy of the rules.
 */
export function createDesignOutput({ artifactBaselineSnippet = "" } = {}) {
  return {
    playbook_router: {
      instruction: PLAYBOOK_ROUTER_INSTRUCTION,
      playbooks: listPlaybooks(),
    },
    design: {
      summary:
        "Use this Luxe CDN fallback only if (1) the user gave no design direction and (2) you already inspected the project the artifact is about and found no design system or style conventions to match. If you have not checked the subject project yet, check first. Luxe does not auto-inject any design system; artifacts stay portable HTML. " +
        DESIGN_PRIORITY_RULE +
        " Paste the CDN snippet below into your `<head>`.",
      cdn_snippet: DESIGN_CDN_SNIPPET,
      cdn_urls: DESIGN_CDN_URLS,
      versions: { tailwind: TAILWIND_BROWSER_VERSION, daisyui: DAISYUI_VERSION },
      latest_docs: "https://daisyui.com/components/",
      docs_note:
        "Use this command for common syntax. Read the latest DaisyUI docs for full details when using advanced or unfamiliar components.",
      layout_safety_note:
        "The layout-safety CSS that used to be offered here is now the artifact baseline below: min-width on grid and flex children, overflow-wrap on prose and cells, and max-width on media. Luxe injects those into every artifact it shows, so there is nothing to remember. Paste `artifact_baseline.snippet` as well if you want the artifact to keep them when opened directly with no Luxe running.",
      other_design_systems:
        "If the user asks for a different design system (Bootstrap, custom CSS, plain HTML, etc.), use that instead - Luxe does not require DaisyUI.",
    },
    diagram_tooling: {
      use_when:
        "Use this for flows / architecture / state / sequence diagrams after opening the diagram playbook; Mermaid handles layout and edge routing better than hand-built div/flexbox boxes.",
      mermaid_cdn_snippet: MERMAID_CDN_SNIPPET,
      cdn_urls: { mermaid: MERMAID_CDN_URL },
      versions: { mermaid: MERMAID_VERSION },
    },
    theme_usage: [
      "Luxe ships exactly one theme and it is light. Paste `luxe_theme_snippet` right after the CDN snippet; it maps DaisyUI's semantic variables onto the Luxe tokens, so every DaisyUI component comes out in the system with no per-element colour work.",
      "Headings are set in Newsreader, a serif, at medium. Body and UI stay in the sans. This is the one place the system uses a second voice, and it is what stops an artifact reading like a settings page - so do not override the heading face, and do not reach for the serif on body copy, labels or controls.",
      "Do not set `data-theme` to one of DaisyUI's stock themes and do not give a section a theme of its own. The stock themes carry their own palettes and would drop a foreign object into the page.",
      "Prefer semantic colors such as `bg-base-100`, `bg-base-200`, `text-base-content`, `bg-primary`, `text-primary-content`, `alert-warning`, and `btn-primary` so the theme block does the work.",
      "Spend colour on data, on status, and on nothing else. Surfaces and type are warm neutrals; `primary` is the cocoa fill; there is no second brand hue to reach for.",
      "Avoid hardcoded Tailwind color names for text and surfaces unless the user asked for exact colors.",
      "Use Tailwind responsive prefixes such as `sm:`, `md:`, `lg:`, and `xl:` for layout changes.",
      'Never `@apply` DaisyUI classes (such as `text-base-content/40`, `bg-base-200`, or `btn`) inside `<style type="text/tailwindcss">` - the Tailwind browser runtime does not know them, and one unknown utility aborts the entire compile, leaving the page with no Tailwind styles at all. Put DaisyUI classes directly on elements, or write plain CSS with theme variables such as `var(--color-base-200)`.',
    ],
    luxe_theme_snippet: LUXE_DAISYUI_THEME_CSS,
    artifact_baseline: {
      note: 'Repairs, not styling. Luxe injects these rules into every artifact it shows, so pasting this is optional - but an artifact that carries them keeps them when opened directly or exported, with no Luxe running. They only change rendering where something would otherwise be clipped, overflow, or be unreadable on the surface behind it, they are wrapped in a zero-specificity `@layer luxe-baseline`, and your own CSS beats them. Paste it first in the `<head>`. Opt out entirely with `<html data-luxe-baseline="off">`.',
      snippet: artifactBaselineSnippet,
    },
    charts: LUXE_CHART_GUIDANCE,
    code_theme: {
      note: "Luxe ships a bespoke Shiki theme. Register it and use it by name wherever the artifact highlights code; the Shiki defaults clash with the Luxe code plane.",
      shiki_theme_json: luxeShikiThemeJson(),
    },
    components: {
      actions: ["button", "dropdown", "fab", "modal", "swap", "theme-controller"],
      data_display: [
        "accordion",
        "avatar",
        "badge",
        "card",
        "carousel",
        "chat",
        "collapse",
        "countdown",
        "diff",
        "hover-3d",
        "hover-gallery",
        "kbd",
        "list",
        "stat",
        "status",
        "table",
        "text-rotate",
        "timeline",
      ],
      navigation: ["breadcrumbs", "dock", "link", "menu", "navbar", "pagination", "steps", "tabs"],
      feedback: ["alert", "loading", "progress", "radial-progress", "skeleton", "toast", "tooltip"],
      data_input: [
        "calendar",
        "checkbox",
        "fieldset",
        "file-input",
        "filter",
        "label",
        "radio",
        "range",
        "rating",
        "select",
        "input",
        "textarea",
        "toggle",
        "validator",
      ],
      layout: ["divider", "drawer", "footer", "hero", "indicator", "join", "mask", "stack"],
      mockup: ["mockup-browser", "mockup-code", "mockup-phone", "mockup-window"],
    },
    modifiers: {
      colors: ["neutral", "primary", "secondary", "accent", "info", "success", "warning", "error"],
      sizes: ["xs", "sm", "md", "lg", "xl"],
      styles: ["outline", "dash", "soft", "ghost", "link"],
      placements: ["start", "center", "end", "top", "middle", "bottom", "left", "right"],
    },
    reference: {
      button: {
        classes: [
          "btn",
          "btn-neutral",
          "btn-primary",
          "btn-secondary",
          "btn-accent",
          "btn-info",
          "btn-success",
          "btn-warning",
          "btn-error",
          "btn-outline",
          "btn-dash",
          "btn-soft",
          "btn-ghost",
          "btn-link",
          "btn-xs",
          "btn-sm",
          "btn-md",
          "btn-lg",
          "btn-xl",
          "btn-wide",
          "btn-block",
          "btn-square",
          "btn-circle",
          "btn-active",
          "btn-disabled",
        ],
        syntax: '<button class="btn btn-primary">Save</button>',
        notes: [
          'Use `btn` on `<button>`, `<a role="button">`, `<input>`, or `<label>`.',
          'For class-only disabled state, add `btn-disabled tabindex="-1" role="button" aria-disabled="true"`.',
          "Use `btn-square` or `btn-circle` for icon-only buttons and provide an accessible label.",
        ],
      },
      card: {
        classes: [
          "card",
          "card-body",
          "card-title",
          "card-actions",
          "card-border",
          "card-dash",
          "card-side",
          "image-full",
          "card-xs",
          "card-sm",
          "card-md",
          "card-lg",
          "card-xl",
        ],
        syntax:
          '<div class="card card-border bg-base-100"><div class="card-body"><h2 class="card-title">Title</h2><p>Text</p><div class="card-actions justify-end"><button class="btn btn-primary">Act</button></div></div></div>',
        notes: [
          "Use `lg:card-side` for responsive horizontal cards.",
          "Use `card-border` for a bordered card without custom CSS.",
        ],
      },
      alert: {
        classes: [
          "alert",
          "alert-outline",
          "alert-dash",
          "alert-soft",
          "alert-info",
          "alert-success",
          "alert-warning",
          "alert-error",
          "alert-vertical",
          "alert-horizontal",
        ],
        syntax: '<div role="alert" class="alert alert-warning"><span>Check this before shipping.</span></div>',
        notes: [
          'Use `role="alert"` for important status messages.',
          "Use `sm:alert-horizontal` to switch from stacked to horizontal layouts.",
        ],
      },
      badge: {
        classes: [
          "badge",
          "badge-outline",
          "badge-dash",
          "badge-soft",
          "badge-ghost",
          "badge-neutral",
          "badge-primary",
          "badge-secondary",
          "badge-accent",
          "badge-info",
          "badge-success",
          "badge-warning",
          "badge-error",
          "badge-xs",
          "badge-sm",
          "badge-md",
          "badge-lg",
          "badge-xl",
        ],
        syntax: '<span class="badge badge-soft badge-warning">Risk</span>',
        notes: ["Use badges for short statuses and labels, not long prose."],
      },
      table: {
        classes: [
          "table",
          "table-zebra",
          "table-pin-rows",
          "table-pin-cols",
          "table-xs",
          "table-sm",
          "table-md",
          "table-lg",
          "table-xl",
        ],
        syntax:
          '<div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100"><table class="table table-zebra"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table></div>',
        notes: ["Wrap tables in `overflow-x-auto` for mobile.", "Use semantic table markup for tabular data."],
      },
      modal: {
        classes: [
          "modal",
          "modal-box",
          "modal-action",
          "modal-backdrop",
          "modal-toggle",
          "modal-open",
          "modal-top",
          "modal-middle",
          "modal-bottom",
          "modal-start",
          "modal-end",
        ],
        syntax:
          '<button class="btn" onclick="details_modal.showModal()">Open</button><dialog id="details_modal" class="modal"><div class="modal-box"><h3 class="text-lg font-bold">Title</h3><p class="py-4">Content</p><div class="modal-action"><form method="dialog"><button class="btn">Close</button></form></div></div></dialog>',
        notes: [
          "Prefer native `<dialog>` with `showModal()` for accessibility.",
          "Use unique IDs for every modal.",
          "Use `modal-bottom sm:modal-middle` for mobile-friendly responsive placement.",
        ],
      },
      collapse: {
        classes: [
          "collapse",
          "collapse-title",
          "collapse-content",
          "collapse-arrow",
          "collapse-plus",
          "collapse-open",
          "collapse-close",
        ],
        syntax:
          '<div tabindex="0" class="collapse collapse-arrow bg-base-200"><div class="collapse-title">Title</div><div class="collapse-content"><p>Hidden detail</p></div></div>',
        notes: [
          "Use a checkbox child for independently toggleable collapses.",
          "Use radio inputs with the same name for accordion behavior where only one item stays open.",
        ],
      },
      drawer: {
        classes: [
          "drawer",
          "drawer-toggle",
          "drawer-content",
          "drawer-side",
          "drawer-overlay",
          "drawer-end",
          "drawer-open",
        ],
        syntax:
          '<div class="drawer lg:drawer-open"><input id="nav" type="checkbox" class="drawer-toggle"><div class="drawer-content"><label for="nav" class="btn drawer-button lg:hidden">Menu</label></div><div class="drawer-side"><label for="nav" aria-label="close sidebar" class="drawer-overlay"></label><ul class="menu bg-base-200 min-h-full w-80 p-4"><li><button>Item</button></li></ul></div></div>',
        notes: [
          "Every page region belongs inside `drawer-content` or `drawer-side`.",
          "The hidden `drawer-toggle` input needs a unique ID.",
          "Use labels with `for` to open and close the drawer.",
        ],
      },
      navbar: {
        classes: ["navbar", "navbar-start", "navbar-center", "navbar-end"],
        syntax:
          '<div class="navbar bg-base-200"><div class="navbar-start"><a class="btn btn-ghost text-xl">Title</a></div><div class="navbar-end"><button class="btn btn-primary">Action</button></div></div>',
        notes: ["Use the start, center, and end parts to align content horizontally."],
      },
      menu: {
        classes: [
          "menu",
          "menu-title",
          "menu-dropdown",
          "menu-dropdown-toggle",
          "menu-disabled",
          "menu-active",
          "menu-focus",
          "menu-dropdown-show",
          "menu-xs",
          "menu-sm",
          "menu-md",
          "menu-lg",
          "menu-xl",
          "menu-horizontal",
          "menu-vertical",
        ],
        syntax:
          '<ul class="menu bg-base-200 rounded-box"><li><button class="menu-active">Item</button></li><li><a>Link</a></li></ul>',
        notes: ["Use `lg:menu-horizontal` for responsive menus.", "Use `<details>` for collapsible submenus."],
      },
      tabs: {
        classes: [
          "tabs",
          "tab",
          "tab-active",
          "tab-disabled",
          "tabs-box",
          "tabs-border",
          "tabs-lift",
          "tab-content",
          "tab-xs",
          "tab-sm",
          "tab-md",
          "tab-lg",
          "tab-xl",
        ],
        syntax:
          '<div role="tablist" class="tabs tabs-border"><button role="tab" class="tab tab-active">One</button><button role="tab" class="tab">Two</button></div>',
        notes: ["Use role attributes when tabs are interactive controls."],
      },
      steps: {
        classes: [
          "steps",
          "step",
          "step-primary",
          "step-secondary",
          "step-accent",
          "step-info",
          "step-success",
          "step-warning",
          "step-error",
          "steps-vertical",
          "steps-horizontal",
        ],
        syntax:
          '<ul class="steps"><li class="step step-primary">Plan</li><li class="step">Build</li><li class="step">Review</li></ul>',
        notes: ["Use `steps-vertical lg:steps-horizontal` for responsive process views."],
      },
      stat: {
        classes: ["stats", "stat", "stat-title", "stat-value", "stat-desc", "stat-figure", "stat-actions"],
        syntax:
          '<div class="stats stats-vertical lg:stats-horizontal shadow"><div class="stat"><div class="stat-title">Issues</div><div class="stat-value">3</div><div class="stat-desc">Need review</div></div></div>',
        notes: ["Use stats for key numbers above dense detail."],
      },
      progress: {
        classes: [
          "progress",
          "progress-neutral",
          "progress-primary",
          "progress-secondary",
          "progress-accent",
          "progress-info",
          "progress-success",
          "progress-warning",
          "progress-error",
          "radial-progress",
        ],
        syntax:
          '<progress class="progress progress-primary" value="70" max="100"></progress><div class="radial-progress" style="--value:70;" role="progressbar" aria-valuenow="70">70%</div>',
        notes: [
          "Progress elements need `value` and `max`.",
          'Radial progress uses `--value`, `role="progressbar"`, and `aria-valuenow`.',
        ],
      },
      forms: {
        classes: [
          "input",
          "textarea",
          "select",
          "checkbox",
          "radio",
          "toggle",
          "range",
          "rating",
          "fieldset",
          "fieldset-legend",
          "label",
          "floating-label",
          "validator",
        ],
        syntax:
          '<fieldset class="fieldset"><legend class="fieldset-legend">Choice</legend><select class="select"><option>One</option></select><p class="label">Helper text</p></fieldset>',
        notes: [
          "Use unique `name` values for each radio, rating, or filter group.",
          "Use matching color and size modifiers such as `input-primary input-lg` when needed.",
        ],
      },
      tooltip_toast: {
        classes: [
          "tooltip",
          "tooltip-open",
          "tooltip-top",
          "tooltip-bottom",
          "tooltip-left",
          "tooltip-right",
          "toast",
          "toast-start",
          "toast-center",
          "toast-end",
          "toast-top",
          "toast-middle",
          "toast-bottom",
        ],
        syntax:
          '<div class="tooltip" data-tip="More context"><button class="btn">Hover</button></div><div class="toast toast-end"><div class="alert alert-success">Saved</div></div>',
        notes: ["Tooltips use `data-tip` for text.", "Toast is a positioned wrapper; put `alert` content inside."],
      },
      mockup: {
        classes: [
          "mockup-browser",
          "mockup-browser-toolbar",
          "mockup-code",
          "mockup-phone",
          "mockup-phone-camera",
          "mockup-phone-display",
          "mockup-window",
        ],
        syntax: '<div class="mockup-code"><pre data-prefix="$"><code>npm test</code></pre></div>',
        notes: [
          "Use `pre data-prefix` for short command prompts, symbols, or line numbers.",
          "Keep `data-prefix` short because DaisyUI renders it in the code gutter; use prose outside the mockup for long labels.",
          "Use mockups for product or terminal examples, not regular prose.",
        ],
      },
      utility_rules: {
        classes: [
          "hero",
          "hero-content",
          "divider",
          "join",
          "join-item",
          "indicator",
          "indicator-item",
          "avatar",
          "chat",
          "chat-start",
          "chat-end",
          "loading",
          "skeleton",
          "diff",
          "timeline",
        ],
        syntax:
          '<main class="mx-auto max-w-6xl p-6 lg:p-10"><section class="hero bg-base-200 rounded-box"><div class="hero-content text-center"><h1 class="text-5xl font-bold">Review surface</h1></div></section></main>',
        notes: [
          "Compose DaisyUI components with Tailwind utilities for spacing, grid, flex, width, and typography.",
          "Prefer component classes over custom CSS for common UI.",
        ],
      },
    },
  };
}
