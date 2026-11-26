# Site check

`atris site check <file|dir>` answers one question: would this page pass the screen standard? It reads every html page it is given and prints one line per fault with the line number, what is wrong and the fix. A page that passes prints `ok`. It exits 0 when every page passes, 1 when one fails and 2 when it finds no html page.

```bash
atris site check page.html
atris site check dist --json
atris site check page.html --render
```

## What it checks

A plain run reads the page as text. It runs the page rules on every page and the content page grammar on content pages. `--json` prints each file with `ok`, `results`, `findings`, `off`, `notChecked`, `rendered` and the same words in `text`.

A plain pass does not cover the browser rules. It says so on the pass line: `every page rule passes. the browser rules did not run`.

`--render` opens each page in an installed Chrome, Chromium, Edge or Brave (`CHROME_PATH` picks one) at 390 and 1280 pixels wide. It adds the browser rules: sideways scrolling, cut off text, text that only a scroll shows, motion that never ends, buttons too small to tap and faults that only appear once scripts run. A full pass then reads `every rule passes`. With no browser it says the browser check did not run and exits 1.

## The rule list

`atris site rules` prints every rule in force, grouped, with the order of work and the upload mode. `--json` gives the same list as `grammar`, `page`, `browser` and `mode`. Read the list there. This page does not copy it.

A project switches one page rule off with `{ "off": ["page-glow"] }` in `.atris/slop.rules.json`. A switched-off rule is still named in every report.

## Content pages

A content page is plain html that starts at `<main>`, with no class, style or script. The words and structure are yours. The tool adds the look.

`atris site <page.html> --look <name> --out <dir>` checks the page and then writes `<dir>/index.html` in that look. `plain` is built in. Other looks live at `atris/looks/<name>.css` and only the owner picks one, at a terminal, with `atris site look pick <name>`.

## Before upload

`atris site publish` and `atris site deploy` run the same check on every html page after any build. See [site-publish.md](site-publish.md#page-check) for watch and block mode.

## Where the rules live

- `lib/page-scan.js` reads html and css into a tree and style declarations, with no packages.
- `lib/page-rules/` holds the page rules: `words.js`, `shape.js` and `look.js` by group, `shared.js` for helpers and the `SAID` sources, `index.js` to run them and read `.atris/slop.rules.json`.
- `lib/page-lang.js` holds the content page grammar, looks, `checkFile` and the upload check.
- `lib/page-render.js` holds the browser rules and the `--render` run.
- `commands/site.js` holds `site check` and `site rules`.

## Adding a rule

Add one object to the array in the file for its group. It needs an `id` that starts with `page-`, the `group`, a one line `line` for the rule list, `why` and `fix` for the report, `said` naming who asked for it (add the source to `SAID` in `shared.js`) and `check(ctx, hit)`, which calls `hit(line, text)` for each fault.

Then add its rows to `test/page-rules.test.js`. `CASES` needs a failing page and a twin that writes the same fault another way. `ATTACKS` takes more ways around the rule that must fire and honest pages like them that must pass. The clean control pages must still pass. `scripts/screen-bench.js` scores the rules against a labelled bench folder, by default `~/.atris/screen-bench-dev`.
