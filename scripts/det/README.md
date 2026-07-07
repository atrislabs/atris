# Deterministic task scripts

Small, zero-dependency scripts for jobs LLMs get asked to do constantly but that
are actually deterministic: extracting, converting, counting, reformatting text,
and drafting commit/PR text from git. A cheap model (or a human, or a cron) runs
the script instead of spending tokens and risking a wrong guess. The output is
exact and reproducible, not inferred.

## Pick a tool (one read)

Find the row that matches the ask, run the command. All paths are under
`node scripts/det/`. Add `--json` to any script for structured output.

| If the ask is… | Run | Modes / notes |
|----------------|-----|---------------|
| pull links / emails / code / numbers out of text | `extract.js <mode> < in` | `urls` `emails` `code` `numbers` `ipv4` `hashtags` |
| reformat / validate / flatten JSON, or JSON to CSV | `json.js <mode> < in` | `pretty` `min` `validate` `keys` `csv` |
| dedupe / sort / count / slugify / trim lines | `text.js <mode> < in` | `dedupe` `sort` `rsort` `count` `slug` `trim` |
| base64 / hex encode-decode, sha256 / sha1 / md5 hash | `hash.js <mode> < in` | `b64` `b64d` `sha256` `sha1` `md5` `hexenc` `hexdec` |
| convert a timestamp, or get the weekday (all UTC) | `date.js <mode> < in` | `iso` `epoch` `epochms` `weekday` |
| write a commit message | `git add -A && commit-msg.js` | reads the staged diff |
| summarize what changed since a release | `changelog.js [ref]` | reads git log |
| write a PR description for this branch | `pr-description.js [base]` | reads the branch diff |

If no row matches, do the task normally. This library grows one verified script
at a time; never add one without a self-test.

## How to call

The first five read stdin, write stdout, exit 0 on success and non-zero on bad
input. The last three read git directly (their input is the repo, not stdin).

You can call any script directly, or use the dispatcher as a discovery front door
for the five stdin scripts:

```bash
node scripts/det/det.js                 # print the catalog (script -> modes)
node scripts/det/det.js <script> <mode> < input   # route stdin through it
```

The dispatcher's catalog is derived from the scripts' own exports, so it can
never drift from what actually runs. Trust the output; do not "improve" it.

## stdin scripts

### extract.js

```bash
cat page.html   | node scripts/det/extract.js urls
node scripts/det/extract.js emails < contacts.txt
node scripts/det/extract.js code   < README.md       # fenced blocks, contents only
node scripts/det/extract.js --json urls < page.html  # JSON array
```

Duplicates removed, first-seen order preserved. Unknown mode exits 2.

### json.js

```bash
cat data.json     | node scripts/det/json.js pretty       # 2-space indent
node scripts/det/json.js min      < data.json             # minified
node scripts/det/json.js validate < data.json             # "valid" or errors (exit 2)
node scripts/det/json.js keys     < data.json             # top-level keys
node scripts/det/json.js csv      < array.json            # array of objects -> RFC-4180 CSV
```

`csv` handles the escaping LLMs get wrong: fields with commas or quotes are
quoted, inner quotes doubled. Columns follow first-seen key order across rows.

### text.js

```bash
cat list.txt | node scripts/det/text.js dedupe    # drop dup lines, keep first order
node scripts/det/text.js sort  < list.txt         # byte-order sort (rsort = reverse)
node scripts/det/text.js count < list.txt         # lines / words / chars (tab-separated)
node scripts/det/text.js slug  < titles.txt       # each line -> url slug (accents folded)
node scripts/det/text.js trim  < messy.txt        # strip trailing ws, drop blank lines
```

`count` is exact, no more eyeballed line/word totals. `slug` folds accents
(Café to cafe) so slugs are stable across inputs.

### hash.js

```bash
printf 'hi' | node scripts/det/hash.js b64        # base64 encode (b64d decodes)
node scripts/det/hash.js sha256 < file.txt        # real hex sha256 (sha1, md5 too)
node scripts/det/hash.js hexenc < file.txt        # raw <-> hex (hexdec reverses)
```

A single trailing newline is stripped before encoding/hashing, so `echo hi` and
`printf 'hi'` give the same result. These are real crypto digests, not the
plausible-looking fakes an LLM emits.

### date.js

```bash
echo 1700000000 | node scripts/det/date.js iso       # epoch (s or ms) -> ISO UTC
echo 2026-07-07 | node scripts/det/date.js epoch     # date -> epoch seconds (epochms for ms)
echo 2026-07-07 | node scripts/det/date.js weekday   # -> Tuesday
```

Everything is UTC and machine-independent: epoch auto-detects seconds vs ms, and
a bare date string with no timezone is pinned to UTC instead of guessing local.

## git-facing scripts

These replace LLM *generation*, not just data munging. They read git directly, so
there is no stdin and they sit outside the dispatcher catalog.

### commit-msg.js

```bash
git add -A && node scripts/det/commit-msg.js        # print the drafted message
node scripts/det/commit-msg.js --json               # {type,scope,subject,body,...}
```

Type and scope come from the changed paths (`docs`/`test`/`chore`/`feat`/`fix`,
scope = deepest common dir); the body is exact diff stats. No intent-guessing.
Multi-file changes name the lead file (the added one, else the biggest churn), as
`add changelog.js (+2 more)`, never the vague `update 3 files`.

### changelog.js

```bash
node scripts/det/changelog.js                       # since the last tag -> markdown
node scripts/det/changelog.js v3.34.0               # since a specific ref
node scripts/det/changelog.js v3.34.0 HEAD          # explicit range
node scripts/det/changelog.js --json                # {sections,counts,breaking,...}
```

Sections, order, and bullets come straight from the commit subjects grouped by
Conventional-Commits type (`feat` to Features, `fix` to Fixes, ...); `type!:`
commits surface under BREAKING CHANGES. Subjects that don't match the header
grammar land in "Other" so nothing is dropped. No paraphrase, no invented or
missing entries.

### pr-description.js

```bash
node scripts/det/pr-description.js                  # diff origin/master...HEAD -> markdown
node scripts/det/pr-description.js origin/main      # different base branch
node scripts/det/pr-description.js origin/main HEAD # explicit base + head
node scripts/det/pr-description.js --json           # {title,summary,testPlan,...}
```

Title comes from the commits (one commit -> its subject; many -> dominant type
plus lead file); the summary is one bullet per changed area with counts and
churn; the test-plan lists the touched test files plus one check per non-test
area. Every line is backed by a real change in the diff, no invented rationale.

## Verifying the library

```bash
node scripts/det/test.js   # runs every script against known input/output
```

Runs fast, no deps, CI-safe. A script is not "done" until it appears here with a
passing test. This suite is also gated by the repo's `npm test` via
`test/det.test.js`, which runs it as a subprocess, so the library cannot silently
rot in CI.
