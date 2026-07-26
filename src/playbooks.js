import { PIERRE_DIFFS_ASSET_FILE, PIERRE_DIFFS_GLOBAL, PIERRE_DIFFS_SHA384 } from "./pierre-diffs-vendor.js";

export const PLAYBOOK_ROUTER_INSTRUCTION =
  "MUST open each matching playbook before writing HTML. Match against the use_when trigger; one artifact often combines several playbooks.";

export const PLAYBOOK_ROUTER_HELP =
  "One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.";

export const PLAYBOOKS = [
  {
    id: "diagram",
    use_when: "Map relationships, flows, state, and architecture",
    choose: [
      "Use Mermaid when automatic node placement and edge routing matter more than rich card content.",
      "Use CSS grid, SVG, or positioned HTML when each item needs prose, code, controls, or detailed annotations.",
      "Use a hybrid shape for large systems: a small overview diagram followed by detailed module cards.",
    ],
    structure: [
      "Lead with the question the diagram answers, not with the implementation detail that produced it.",
      "Keep the first visual to the core relationship, then put dense evidence or file references below it.",
      "For complex systems, separate topology from detail so the overview stays readable.",
    ],
    design_rules: [
      "Use page-scoped class names and avoid generic names like .node that can collide with diagram libraries.",
      "Prefer top-down flow for multi-step diagrams unless the flow is genuinely linear and short.",
      "Quote labels that contain punctuation or code-like names, and use explicit line breaks where the renderer supports them.",
      "If the artifact also charts data, follow the chart rules `luxe design` prints under `charts`: fixed slot order, and every chart carries direct labels, printed values, or a table view. A legend on its own is not enough.",
      "Initialize Mermaid with the `luxe design` Mermaid snippet exactly as printed. It carries the Luxe `themeVariables` block, which is what makes a diagram inherit the system; a bare `theme:` name leaves Mermaid on its own beige fills and purple borders, which read as a foreign object dropped into the page.",
      "Reserve the annotation gold for annotation. It is never a node fill, an edge colour, or a highlight inside a diagram.",
    ],
    pitfalls: [
      "Do not cram every file or function into one diagram when a layered explanation would be clearer.",
      "Do not hand-build boxes-and-arrows from div/flexbox for a flow: it does not auto-route edges and reads worse than Mermaid; reach for Mermaid or SVG for richly annotated nodes.",
      "Do not let default diagram colors into the page: initializing Mermaid without the Luxe `themeVariables` block is the usual way this happens.",
      "Do not present unverified architecture claims as facts. Cite the files or commands that support them.",
    ],
    luxe_notes: [
      "A Luxe diagram should invite precise annotation: make modules, edges, and captions easy to click and discuss.",
      "When a relationship is uncertain, label it as a question so the user can resolve it in the review loop.",
    ],
  },
  {
    id: "table",
    use_when: "Turn dense records into scan-friendly review surfaces",
    choose: [
      "Use a table when rows share the same fields and the user needs to compare evidence quickly.",
      "Use cards when each record has a different shape or needs a long explanation.",
      "Use summaries above the table when counts, risk levels, or statuses change how the table should be read.",
    ],
    structure: [
      "Start with a short summary of what the rows prove or require.",
      "Group columns by the decision they support: identity, evidence, status, action.",
      "Keep raw details available, but make the primary status visible without reading every cell.",
    ],
    design_rules: [
      "Use semantic table markup when the data is tabular.",
      "Protect long paths, code symbols, URLs, and prose from overflowing on narrow screens.",
      "Use restrained color for status and severity so the table remains readable when printed or skimmed.",
    ],
    pitfalls: [
      "Do not paste a terminal table into HTML and call it done.",
      "Do not hide the important conclusion below a large undifferentiated grid.",
      "Do not use color as the only status signal.",
    ],
    luxe_notes: [
      "A Luxe table should make individual rows easy annotation targets.",
      "If a row implies a follow-up change, include an action control that queues a specific prompt.",
    ],
  },
  {
    id: "comparison",
    use_when: "Show options, tradeoffs, and current vs target behavior",
    choose: [
      "Use before and after when the same system is changing over time.",
      "Use option cards when the user needs to choose between mutually exclusive directions.",
      "Use a scorecard only when the criteria are explicit and comparable.",
    ],
    structure: [
      "Name the decision at the top of the artifact.",
      "Show the concrete behavior or artifact shape for each side, not just abstract pros and cons.",
      "End with a recommendation only when the evidence actually supports one.",
    ],
    design_rules: [
      "Keep corresponding details aligned so differences are visible without hunting.",
      "Use visual hierarchy to separate primary tradeoffs from secondary notes.",
      "Make the cost of each option as visible as the benefit.",
    ],
    pitfalls: [
      "Do not make every option look equally recommended if one is clearly preferred.",
      "Do not compare vague summaries when concrete examples are available.",
      "Do not bury assumptions that would change the recommendation.",
    ],
    luxe_notes: [
      "A Luxe comparison should let the user annotate the exact option or tradeoff they want changed.",
      "If the goal is selection, provide controls that queue the chosen option with rationale.",
    ],
  },
  {
    id: "plan",
    use_when: "Explain a product or technical plan before implementation",
    choose: [
      "Use this when the user needs to inspect a feature approach before implementation begins.",
      "Use it when the user explicitly asked for a PRD, technical design, implementation plan or proposal.",
      "Use a lighter comparison or diagram playbook when the plan is only a single small design choice.",
    ],
    structure: [
      "Start with the goal, the current state, and desired behavior.",
      "Then describe a proposed approach, focusing on high level decisions.",
      "At the end, list any risks you see, and open questions you have, and follow the 'comparison' playbook to provide options for the user to choose from.",
    ],
    design_rules: [
      "Verify each claim against the codebase before presenting it as fact.",
      "When discussing frontend experiences, prefer visually mocking the experience under a consistent design system as the real product over describing it with text.",
      "The plan needs to be self-contained enough that another developer can read it and fully implement the proposal.",
    ],
    pitfalls: [
      "Do not leave resolved open questions in the artifact. Update existing content to reflect the decision and remove the open question.",
      "Do not only focus on ambiguous decisions and omit the actual proposal.",
      "Do not omit failure modes, migration concerns, or backwards compatibility questions.",
    ],
    luxe_notes: ["A Luxe plan should make a plan and its uncertainties easy to annotate before code exists."],
  },
  {
    id: "code",
    use_when: "Render source code, code files, patches, PR diffs, and before/after code inside Luxe artifacts",
    choose: [
      "Use this whenever an artifact shows source code: a snippet, full file, patch, PR diff, local change set, or before/after code.",
      "Use File for one code file, FileDiff for old/new versions or parsed patch metadata, and CodeView only when several files or diffs need coordinated navigation.",
      "Choose split layout for careful side-by-side review when width allows; choose unified layout when space is tight, changes are mostly additive, or mobile readability matters.",
    ],
    structure: [
      "Place the path, language, and reason to inspect the code immediately before each rendered file or diff.",
      "Keep evidence close to each claim with file paths, line references, or annotations next to the relevant code.",
      "For multi-file changes, group files by user-facing area or task instead of dumping a raw patch in repository order.",
    ],
    design_rules: [
      `Rendering MUST use @pierre/diffs, not hand-rolled <pre> blocks or another diff library. Before writing the artifact, run \`luxe copy-code-assets <html-file>\`. It copies the hash-checked ${PIERRE_DIFFS_ASSET_FILE} (${PIERRE_DIFFS_SHA384}) beside the artifact. Keep that local asset beside the HTML until \`luxe export\` inlines it. This verified browser-safe snippet renders one file and one split diff without executing a CDN response:
\`\`\`html
<div id="file"></div>
<div id="diff"></div>
<script src="./${PIERRE_DIFFS_ASSET_FILE}"></script>
<script>
  const { File, FileDiff, registerCustomTheme } = window.${PIERRE_DIFFS_GLOBAL};

  // Inline the JSON \`luxe design\` prints as code_theme.shiki_theme_json, or load it
  // from a sibling file - the artifact must stay portable, so do not fetch it remotely.
  const luxeShikiTheme = { /* ...code_theme.shiki_theme_json... */ };

  // The bundle resolves themes by NAME through a registry: it does not accept a theme
  // object on \`options.theme\`. Passing the JSON directly fails at render time with
  // \`No valid theme loader registered for "undefined"\` and every block comes out
  // unhighlighted. Register the theme once, then name it.
  registerCustomTheme("luxe", () => Promise.resolve(luxeShikiTheme));

  const options = { theme: "luxe", themeType: "light", overflow: "wrap" };
  const oldFile = {
    name: "src/greeting.ts",
    contents: "export function greet(name: string) {\\n  return \\"Hello \\" + name;\\n}\\n\\nconsole.log(greet(\\"Luxe\\"));\\n",
  };
  const newFile = {
    name: "src/greeting.ts",
    contents: "export function greet(name: string) {\\n  return \\"Hello, \\" + name + \\"!\\";\\n}\\n\\nconsole.log(greet(\\"Luxe\\"));\\n",
  };

  new File(options).render({
    containerWrapper: document.querySelector("#file"),
    file: newFile,
  });

  new FileDiff({ ...options, diffStyle: "split" }).render({
    containerWrapper: document.querySelector("#diff"),
    oldFile,
    newFile,
  });

</script>
\`\`\``,
      'Register the bespoke Luxe Shiki theme printed by `luxe design` (`code_theme.shiki_theme_json`) with `registerCustomTheme("luxe", () => Promise.resolve(theme))`, then pass the NAME as `theme: "luxe"`, exactly as the snippet above shows. The bundle resolves themes through a name registry and never accepts a theme object, so `theme: themeJson` renders every block unhighlighted. The Luxe theme is built against the Luxe code plane, and every one of its syntax tokens is deep enough to survive on the added and removed diff tints.',
      'Use FileDiff diffStyle: "split" for side-by-side review and diffStyle: "unified" for stacked reading; keep overflow: "wrap" unless horizontal alignment is essential.',
      "Use @pierre/diffs line annotations, selections, and headers when calling out specific lines so notes stay attached to code.",
    ],
    pitfalls: [
      "Do not render code as static screenshots, plain <pre> blocks, or markdown pasted into HTML.",
      "Do not pass a theme object to `options.theme`. It fails as an unhandled async rejection *after* `render()` has already returned, so nothing throws where you can see it and the block simply comes out empty or unhighlighted. Register by name instead, and check the console before shipping a code artifact.",
      "Do not choose an arbitrary stock Shiki theme. Its palette will not match the Luxe code plane, and its pale syntax tokens wash out on the diff tints.",
      "Do not show huge unrelated files when a focused render range, parsed patch file, or grouped summary would be clearer.",
      "Do not separate a claim from the code lines that prove it.",
    ],
    luxe_notes: [
      "A Luxe code artifact should make each file, hunk, and relevant line easy to annotate precisely.",
      "When a user action should trigger a fix, queue prompts that name the file path, line range, and desired change.",
      "If the artifact combines code with a plan, table, or comparison, read those playbooks too and keep @pierre/diffs responsible for the code surface.",
    ],
  },
  {
    id: "input",
    use_when:
      "Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact",
    choose: [
      "Use this when the user needs to select, tune, triage, annotate, or edit a structured choice.",
      "Use controls for decisions the user can make faster visually than by writing a prompt.",
      "Use plain annotations when the artifact only needs open-ended feedback.",
    ],
    structure: [
      "Make each decision surface visible: what is being chosen, what the options mean, and what happens next.",
      "Keep reversible selection state local in the artifact until the user explicitly submits that question.",
      "Pair each question with a Submit or Queue answer control that queues exactly one prompt for the final answer.",
      "Show selected state separately from queued state so the user trusts what will be sent back.",
    ],
    design_rules: [
      "Native controls - radios, checkboxes, text inputs, selects, textareas, buttons, options, labels, disclosure summaries, and contenteditable regions - are interactive automatically: clicks toggle, focus, and type instead of annotating, so they do not need data-luxe-action. Build choice and option UIs from these whenever you can.",
      "For reversible choices, do not call window.luxe.queuePrompt() from radio change handlers or option click handlers. Those handlers should only update local selected state.",
      "Use a per-question form submit or explicit Queue answer button to read the current values and call window.luxe.queuePrompt() exactly once for the final answer.",
      "Put data-luxe-action only on custom (non-native) elements that should act like a feedback control - typically a styled div or span you made clickable - so Luxe does not annotate it and shows a pointer cursor instead.",
      "Use data-luxe-question on a question wrapper or pass queueKey when multiple pre-send updates should replace the prior unsent answer for the same question.",
      "Pass options such as tag, text, selector, target, data, queueKey, or element when they help the agent understand exactly what the user chose.",
      "Artifact controls may queue feedback only. The human must confirm transmission with Send to Agent or Send & End in the Luxe conversation chrome.",
      "Make queued prompts specific enough that the agent can act without asking a follow-up question.",
      "Keep native browser controls accessible and readable on mobile.",
    ],
    pitfalls: [
      "Do not queue one prompt per radio change, checkbox toggle, dropdown change, or choice-button click when the user can still change their mind.",
      "Do not create controls whose queued prompt is unclear or too vague to execute.",
      "Do not hide the difference between selected locally and queued for the agent.",
      "Do not require interaction for content the user only needs to read.",
    ],
    luxe_notes: [
      "Luxe is strongest when the artifact becomes a focused review surface and not just a static page.",
      'A native single-choice question should submit the final value: `<form data-luxe-question="plan" onsubmit="event.preventDefault(); const choice = new FormData(event.currentTarget).get(\'plan\'); if (choice) window.luxe.queuePrompt(\'Use the \' + choice + \' plan\', { tag: \'choice\', text: \'Plan: \' + choice, element: event.currentTarget, data: { question: \'plan\', answer: choice } });"><label><input type="radio" name="plan" value="Starter"> Starter</label><label><input type="radio" name="plan" value="Pro"> Pro</label><button type="submit">Queue this answer</button></form>`.',
      "A custom choice UI should make option buttons update local state, then use a separate Queue answer button with data-luxe-action to queue the final selected value.",
      "Use window.luxe.queuePrompt for user intent, not internal analytics or UI-only state changes.",
      "End input paths by directing the user to confirm queued feedback from the Luxe conversation chrome.",
    ],
  },
];

export function listPlaybooks() {
  return PLAYBOOKS.map(({ id, use_when }) => ({ id, use_when }));
}

export function findPlaybook(id) {
  return PLAYBOOKS.find((playbook) => playbook.id === id) || null;
}

export function playbookIds() {
  return PLAYBOOKS.map((playbook) => playbook.id);
}
