# Deterministic task scripts

Small, zero-dependency scripts for jobs LLMs get asked to do constantly but that
are actually deterministic: extracting, converting, counting, reformatting text.
A cheap model (or a human, or a cron) runs the script instead of spending tokens
and risking a wrong guess. Every script reads stdin, writes stdout, exits 0 on
success and non-zero on bad input.

## Contract for a calling agent

One entrypoint, no need to know the file layout:

```bash
node scripts/det/det.js                 # print the catalog (script -> modes)
node scripts/det/det.js <script> <mode> < input   # route stdin through it
```

1. Run `det.js` with no args to see every script and mode.
2. Match the ask, then pipe the source in: `cat source | node scripts/det/det.js <script> <mode>`.
3. Trust the output — it is exact, not inferred. Do not "improve" it.

You can also call a script directly (`node scripts/det/extract.js urls`); the
dispatcher is just the discovery front door. Its catalog is derived from the
scripts' own exports, so it can never drift from what actually runs.

If no script matches, do the task normally. This library grows one verified
script at a time; never add one without a self-test.

## Scripts

| Task the LLM is asked | Script | Modes |
|-----------------------|--------|-------|
| "pull all the links / emails / code out of this" | `extract.js` | `urls` `emails` `code` `numbers` `ipv4` `hashtags` |
| "reformat / validate / flatten this JSON" | `json.js` | `pretty` `min` `validate` `keys` `csv` |
| "dedupe / sort / count / slugify these lines" | `text.js` | `dedupe` `sort` `rsort` `count` `slug` `trim` |
| "base64 / hash this" | `hash.js` | `b64` `b64d` `sha256` `sha1` `md5` `hexenc` `hexdec` |

### extract.js

```bash
cat page.html   | node scripts/det/extract.js urls
node scripts/det/extract.js emails < contacts.txt
node scripts/det/extract.js code   < README.md      # fenced ```blocks, contents only
node scripts/det/extract.js --json urls < page.html  # JSON array
```

Duplicates removed, first-seen order preserved. Unknown mode exits 2.

### json.js

```bash
cat data.json     | node scripts/det/json.js pretty       # 2-space indent
node scripts/det/json.js min      < data.json              # minified
node scripts/det/json.js validate < data.json             # "valid" or errors (exit 2)
node scripts/det/json.js keys     < data.json             # top-level keys
node scripts/det/json.js csv      < array.json            # array of objects -> RFC-4180 CSV
```

`csv` handles the escaping LLMs get wrong: fields with commas or quotes are
quoted, inner quotes doubled. Columns follow first-seen key order across rows.

### text.js

```bash
cat list.txt | node scripts/det/text.js dedupe   # drop dup lines, keep first order
node scripts/det/text.js sort  < list.txt         # byte-order sort (rsort = reverse)
node scripts/det/text.js count < list.txt         # lines / words / chars (tab-separated)
node scripts/det/text.js slug  < titles.txt       # each line -> url slug (accents folded)
node scripts/det/text.js trim  < messy.txt        # strip trailing ws, drop blank lines
```

`count` is exact — no more eyeballed line/word totals. `slug` folds accents
(Café -> cafe) so slugs are stable across inputs.

### hash.js

```bash
printf 'hi' | node scripts/det/hash.js b64        # base64 encode (b64d decodes)
node scripts/det/hash.js sha256 < file.txt        # real hex sha256 (sha1, md5 too)
node scripts/det/hash.js hexenc < file.txt        # raw <-> hex (hexdec reverses)
```

A single trailing newline is stripped before encoding/hashing, so `echo hi` and
`printf 'hi'` give the same result. These are real crypto digests, not the
plausible-looking fakes an LLM emits.

## Verifying the library

```bash
node scripts/det/test.js   # runs every script against known input/output
```

Runs fast, no deps. CI-safe. A script is not "done" until it appears here with a
passing test.
