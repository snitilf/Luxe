---
name: luxe-design
description: Use this skill to design and build interfaces, artifacts and assets in the Luxe brand, for production code or for throwaway prototypes and mocks. Contains the design tokens, the written rules, specimen cards for every part of the system, and a lint that checks your output against it.
user-invocable: true
metadata:
  internal: true
---

Read `README.md` in this skill, then open the specimen cards in `preview/` for whatever you are about to build.

If you are producing a visual artifact - a page, a mock, a throwaway prototype - copy `tokens.css` next to it, import it, and build with the variables. If you are working on production code inside this repository, do not copy anything: `src/luxe-tokens.css` is the same file and is already wired into the chrome, the artifact SDK, the diagram theme and the code theme.

If the user invokes this skill with no other guidance, ask what they want to build, ask the questions a designer would ask, and then produce either an HTML artifact or production code depending on what the answer needs.

## Where things live

- `README.md` - the system: what it is, what each part is for, and the rules that are not visible in the token names
- `tokens.css` - every token, generated verbatim from `src/luxe-tokens.css`
- `adherence.json` - the same tokens as data, plus the families, sizes, weights and radii the lint enforces
- `preview/` - one specimen card per concept, each linking `preview/_base.css`
- `assets/` - the mark and the wordmark

Both `tokens.css` and `adherence.json` are generated. Change `src/luxe-tokens.css`, then run `npm run build:design-skill`. Editing either file directly is undone by the next build, and `npm run check` fails while they disagree.

## Rules of thumb

1. **Light only.** One theme. No dark palette, no `prefers-color-scheme`, no toggle. This is a decision, not an omission.
2. **Colour is information.** Charts get colour. Status gets colour. The annotation stroke gets colour. Everything else is paper and ink.
3. **One accent, one meaning.** The gold marks annotation and selected text, and nothing else. It is not the focus ring, not a chart colour, not a link, not a button.
4. **Two families, four sizes, two weights.** Emphasis is weight 500 or a size already in the scale.
5. **Never hard-code a value.** Every colour, radius and size resolves through `var(--token)`. The only exceptions are SVG artwork and anything handed to a third-party library as a literal, and both are pinned by tests.
6. **Depth is planes and hairlines.** One shadow token exists and it belongs to the modal.
7. **Status is icon plus label**, never colour alone. **Charts carry direct labels or printed values**, never a legend alone.
8. **Words before icons.** No icon font, no icon CDN, no emoji anywhere.

## To produce a new artifact

1. Copy `tokens.css` beside your file and `@import` it, or inline the `:root` block if the file has to stand alone.
2. Set `font-family: var(--font-sans)` on the body and build with the semantic variables.
3. Author diagrams in Mermaid with the shipped theme rather than drawing them from divs. `npx -y editeur-luxe design` prints the snippet.
4. Reference `assets/luxe-wordmark.svg` for the brand mark. Do not redraw it and do not set the name in another face.
5. Run the lint on what you produced: `node scripts/check-design-adherence.js <your-file>`.
