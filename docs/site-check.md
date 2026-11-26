# Site check

`atris site check <file|dir>` answers one question: would this page pass the screen standard? It reads every html page it is given and prints one line per fault with the line number, what is wrong and the fix. A page that passes prints `ok`. Notes for the reviewer print after these lines and never fail a page. It exits 0 when every page passes, 1 when one fails and 2 when it finds no html page.

```bash
atris site check page.html
atris site check dist --json
atris site check page.html --render
```

Run every site command from the project root. The rules file `.atris/slop.rules.json`, the theme picks in `.atris/theme.json` and the build are all read from the folder the command runs in. A rules file in a parent folder is not read.

## What it checks

A plain run reads the page as text. It runs the page rules on every page and the content page grammar on content pages.

A class name counts as a style only on a page whose styles the check could not all read: a remote sheet, or a script file the check does not open on a page with a class no read sheet defines. That script is named as not read. A class name can add a finding and never hides words from the rules. On such a page or on a page a script draws, each rule that passed reads `null` in `--json` instead of `true`.

A plain pass does not cover the browser rules. The pass line says so and names the command that runs them:

```
ok page.html: every page rule passes. the browser rules did not run: atris site check page.html --render runs them
```

The command in that line is ready to paste. A path that starts with a dash gets `./` in front. On mac and linux a path with a space or a shell character, or one that starts with `=` or `~`, is put in single quotes. On Windows such a path is put in double quotes.

`--render` opens each page in an installed Chrome, Chromium, Edge or Brave (`CHROME_PATH` picks one) at 390 and 1280 pixels wide. It adds the browser rules: sideways scrolling, cut off text, text that only a scroll shows, motion that never ends, buttons too small to tap and faults that only appear once scripts run. A full pass then reads `ok page.html: every rule passes`.

A page a script draws gets a note on its pass line. Without `--render` the note says its words and look were not read. With `--render` the note goes away once the browser sees words. If the browser saw no words after the wait the note reads `a script draws this page and the browser saw no words after the wait. its words were not read`.

When `--render` is asked and the browser cannot run, the pass line ends with `the browser rules did not run` and a second line gives the reason: `the browser check did not run on page.html: <reason>`. The command exits 1. The reasons are:

- No browser was found. Install one or set `CHROME_PATH`.
- `CHROME_PATH <path> is not a file`: the set path is named and no other browser is picked in its place.
- The browser stopped and printed nothing: `the browser <path> stopped with code <n> and printed nothing. check CHROME_PATH`, or `stopped with signal <name>` when something killed it.
- The page did not finish loading in time at one width.
- The browser did not finish within 30 seconds at one width.

`--json` prints each file with `ok`, `results`, `findings`, `off`, `notChecked`, `rendered` and the same words in `text`. Each finding has a `level`: `error` for a fault to fix and `warn` for a note for the reviewer, with `maybe` saying why it may be fine. `rendered` is true only when the browser rules ran. `reason` is there when `--render` was asked and the browser did not run.

## Notes for the reviewer

A rule blocks only when the file itself proves the fault: the character, the banned word, a css value or a shape of markup. A hit that decides what words mean or what an element is for from a list of phrases or from class, id or icon names is a guess. A guess prints as a note for the reviewer:

```
ok page.html: every page rule passes. the browser rules did not run: atris site check page.html --render runs them
page.html:7 for the reviewer: text about the page or a helper caption: "This page lists every draft". it may be fine: <why>.
```

A note never fails a page. The check exits 0, `ok` stays true and publish, deploy and the landing gate go ahead in every mode. The count in `N things to fix` counts only the faults. They print before the notes. `site rules` marks each rule that only leaves notes and each rule with a part that does. The landing gate keeps the notes for a new page in `page_notes` on its record. It reads every new html file, a piece of a page too. A new page it could not read in full is named in an advisory.

## The rule list

`atris site rules` prints every rule in force, grouped, with the order of work (the `## screens` bullets of atris.md) and the upload mode. It lists 7 content page rules, 25 page rules in three groups and 7 browser rules that only run with `--render`. `--json` gives the same list as `grammar`, `page`, `browser`, `mode` and `off`. Read the list there. This page does not copy it.

A project switches one page rule off with `{ "off": ["page-glow"] }` in `.atris/slop.rules.json`. A switched-off rule is still named: on a passing check (`switched off in .atris/slop.rules.json: page-glow`), on a passing upload, in the upload's `page_check` field and in `site rules`, as text and in `off` in `--json`.

## A rules file that cannot be read

When `.atris/slop.rules.json` is there and is not valid json, or does not hold a json object, every site command names it on stderr. The same goes for a `pages` value that is neither `"block"` nor `"watch"` and an `off` that is not a list. A plain list, the form `atris slop rules --add` writes, is fine and means watch mode.

```
.atris/slop.rules.json could not be read: <why>
```

`site check` still checks the pages. `site rules` says the project's mode is unknown until the file can be read. In `--json` its `mode` is `unknown`. Publish and deploy upload nothing. See [site-publish.md](site-publish.md#page-check). A failing new page does not land until the file reads. A rule id in `off` that matches no rule is dropped without a word.

## Content pages

A content page is plain html that starts at `<main>`, with no class, style or script. The words and structure are yours. The tool adds the look.

`atris site <page.html> --theme <name> --out <dir>` checks the page and then writes `<dir>/index.html` in that theme, the same themes `atris theme list` shows for markdown sites. Without `--theme` it builds in `plain`. A theme gives the page its colours and fonts through elements only. The built page must pass every page rule too. A theme with a banned font is refused. Only the owner picks a theme for content pages, at a terminal, with `atris theme pick <name>`. The pick is kept in `.atris/theme.json` and `atris theme list` says which themes are picked.

## Before upload

`atris site publish` runs the same check on every html page after any build. `atris site deploy` runs it on the html pages in the folder. `--fullstack` reads only the html already in the folder and says so, since the server builds its pages after the upload. See [site-publish.md](site-publish.md#page-check) for watch and block mode.

## Where the rules live

- `lib/page-scan.js` reads html and css into a tree and style declarations, with no packages.
- `lib/page-rules/` holds the page rules: `words.js`, `shape.js` and `look.js` by group, `shared.js` for helpers and the `SAID` sources, `index.js` to run them and read `.atris/slop.rules.json`.
- `lib/page-lang.js` holds the content page grammar, looks, `checkFile` and the upload check.
- `lib/page-render.js` holds the browser rules and the `--render` run.
- `commands/site.js` holds `site check` and `site rules`.
- `atris slop detect --kind screen` hands each html page to the same check and prints what it did not read and which rules are off. `atris slop rules --kind screen` marks the rules html pages skip.

## Adding a rule

Add one object to the array in the file for its group. It needs an `id` that starts with `page-`, the `group`, a one line `line` for the rule list, `why` and `fix` for the report, `said` naming who asked for it (add the source to `SAID` in `shared.js`) and `check(ctx, hit)`, which calls `hit(line, text)` for each fault. A rule that guesses from phrases or names gets `level: 'warn'` and a `maybe` line. A rule with one guessed part calls `hit(line, text, 'warn')` for that part and has a `maybe` line too.

Then add its rows to `test/page-rules.test.js`. `CASES` needs a failing page and a twin that writes the same fault another way. `ATTACKS` takes more ways around the rule that must block (`true`) or leave a note (`'note'`) and honest pages like them that must pass (`false`). The clean control pages must still pass. `scripts/screen-bench.js` scores the rules against a labelled bench folder, by default `~/.atris/screen-bench-dev`.
