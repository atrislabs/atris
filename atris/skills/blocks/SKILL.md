---
name: blocks
description: Author Atris block documents — the live markdown docs the Atris (obelisk) editor renders, with charts, gauges, metrics, tables, and images. One doc is a beautiful one-pager; add slide breaks and it presents as a deck. Use when creating or editing an Atris doc, deck, one-pager, report, or anything opened in the Atris markdown editor.
version: 1.0.0
tags:
  - blocks
  - editor
  - deck
  - one-pager
  - markdown
---

# Atris block-creator

Author documents the Atris desktop editor renders as **live blocks**: charts, gauges,
metric cards, tables, and images inside plain markdown. Same file is a one-pager or a
deck — the only difference is slide breaks.

The whole thing is one `.md` file. Prose is prose. A fenced code block with a known
language becomes a live visual. A `---` on its own line starts a new slide.

## Where things live

The renderer lives in the Atris desktop app (obelisk repo), at
`project-obelisk/src/lib/markdownEditorIo.cjs` (engine) and `renderEmbedBlockHtml` in
`project-obelisk/src/components/AppExperience.tsx` (block defs). Present mode:
`MarkdownPresentView.tsx`. Working templates: `project-obelisk/atris/decks/`
(`blocks-demo.md`, `generative-blocks.md`). Validate against the engine (below) —
it's the source of truth, no app needed.

## Doc shape

- **One-pager:** no `---`. Just headings, prose, and blocks. Scrolls.
- **Deck:** `---` alone on a line between slides. Present mode splits on it; export makes a PDF.
- A leading `---...---` frontmatter block is skipped by the slide splitter, so it's safe.

## The blocks

Each is a fenced code block. The body must be **valid JSON** — invalid JSON silently
falls back to a plain code block (no error), so validate. Colors/accents are hex strings.

### metric — a stat card
```metric
{"label":"MRR from paying customers","value":"$20K+","accent":"#f0a13a"}
```
`label`, `value` (string), optional `accent`. Put several in a row; they stack as cards.

### gauge — a ring toward a target
```gauge
{"title":"Ledger reconciled","value":100,"max":100,"caption":"ties back to the board, to the penny"}
```
`title` (or `label`), `value`, `max`, optional `caption`, `accent`.

### chart — line / bar / area / donut
Single series (friendly `data` form):
```chart
{"kind":"bar","title":"Weekly active sessions","data":[{"label":"W1","value":12},{"label":"W2","value":19},{"label":"W3","value":27}]}
```
Multiple series (line, with colors — great for "rent rises vs own falls"):
```chart
{"kind":"line","title":"Cost per unit of work","series":[{"name":"Rent","color":"#d16a5a","points":[{"label":"Y1","value":40},{"label":"Y2","value":88}]},{"name":"Own","color":"#3f9668","points":[{"label":"Y1","value":38},{"label":"Y2","value":12}]}],"caption":"same work, opposite curves"}
```
Donut (first series' points become slices; center shows the total):
```chart
{"kind":"donut","title":"Jobs on the live board","data":[{"label":"Credited","value":337},{"label":"Open","value":241}]}
```
`kind`: `line` | `bar` | `area` | `donut`. Points are `{"label","value"}`. Optional `unit`, `caption`. A chart with no points renders nothing, so always include data.

### table — an editable grid
Plain GFM. Renders as a clean grid, round-trips verbatim. First column can be a blank header for a comparison.
```
| | Rent | Own |
| --- | --- | --- |
| Price | Set by the landlord | You control it |
| Data | Their building | Your walls |
```

### image — a picture
```image
{"url":"https://...","alt":"..."}
```
A data: or https: URL renders immediately. Without one, the editor shows a placeholder and generates (non-deterministic — don't rely on generation for something you're about to present).

### ask — an embedded AI answer
```ask
{"output":"the answer, as markdown"}
```
Renders `output` as prose. Authored by the editor's in-app AI; rarely hand-written.

## Gotchas (these cost real time)

- **No side-by-side columns by hand.** `md-cols` only parses as a single unbroken line and breaks the moment you add newlines/bullets. Use a **table** for comparisons. Columns are a UI-only construct.
- **Invalid JSON = silent fallback** to a code block. No error is thrown. Validate.
- **A chart needs data points** or it renders empty.
- **Raw HTML is sanitized** — inline `style=` and `<style>`/`<script>` are stripped. You cannot brand a doc with custom CSS; it wears the editor's theme. Design with the blocks, not CSS.
- **`---` is a hard slide break.** A stray `---` inside a slide splits it. GFM table delimiters (`| --- |`) are safe.

## Validate before you trust it

Run the doc through the real engine — no app needed. This auto-finds obelisk's engine
from any project in the workspace:

```bash
node -e '
const fs=require("fs"),path=require("path");
const eng=["./src/lib/markdownEditorIo.cjs","../project-obelisk/src/lib/markdownEditorIo.cjs",process.env.HOME+"/arena/project-obelisk/src/lib/markdownEditorIo.cjs"].map(p=>path.resolve(p)).find(fs.existsSync);
if(!eng){console.error("obelisk engine not found");process.exit(2);}
const io=require(eng), md=fs.readFileSync(process.argv[1],"utf8");
const slides=io.splitIntoSlides(md);
console.log("slides:",slides.length);
slides.forEach((s,i)=>{
  const b=io.parseMarkdownBlocks(s);
  const live=b.filter(x=>["chart","gauge","metric","image","ask"].includes(x.lang||""));
  const ok=live.length? /data-md-block/.test(io.blocksToHtml(b)) : true;
  console.log((i+1)+".",(s.match(/^#+ (.*)/m)||[])[1]||"", live.map(x=>x.lang).join(",")||"", ok?"":"LIVE-FAIL");
});
' path/to/doc.md
```

`LIVE-FAIL` means a block will not render (usually bad JSON). Fix and re-run.

## Open / present / export

- **Open:** in the app, Cmd+P → type the filename → Enter. (Quick Open searches the open project only — the file must live under it.)
- **Edit a block:** click the chart/number; a form opens to change values. No JSON editing needed.
- **Insert a block:** type `/` for the block menu.
- **Present:** the Present button (splits on `---`); arrows/space to move, Esc to exit.
- **Export:** Export button → PDF or Google Doc.

## Taste

Lead with the blocks that carry meaning, one hero visual per slide. A number that
matters is a `metric`. A trend or a crossing is a `chart`. A comparison is a `table`.
Everything else is tight prose. Don't decorate — the doc should read clean at a squint.
