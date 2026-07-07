# Deterministic task scripts

Small, zero-dependency scripts for jobs LLMs get asked to do constantly but that
are actually deterministic: extracting, converting, counting, reformatting text.
A cheap model (or a human, or a cron) runs the script instead of spending tokens
and risking a wrong guess. Every script reads stdin, writes stdout, exits 0 on
success and non-zero on bad input.

## Contract for a calling agent

1. Match the ask to a script in the table below.
2. Pipe the source text into it: `cat source | node scripts/det/<script>.js <mode>`.
3. Trust the output — it is exact, not inferred. Do not "improve" it.

If no script matches, do the task normally. This library grows one verified
script at a time; never add one without a self-test.

## Scripts

| Task the LLM is asked | Script | Modes |
|-----------------------|--------|-------|
| "pull all the links / emails / code out of this" | `extract.js` | `urls` `emails` `code` `numbers` `ipv4` `hashtags` |
| "reformat / validate / flatten this JSON" | `json.js` | `pretty` `min` `validate` `keys` `csv` |

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

## Verifying the library

```bash
node scripts/det/test.js   # runs every script against known input/output
```

Runs fast, no deps. CI-safe. A script is not "done" until it appears here with a
passing test.
