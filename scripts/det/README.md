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

### extract.js

```bash
cat page.html   | node scripts/det/extract.js urls
node scripts/det/extract.js emails < contacts.txt
node scripts/det/extract.js code   < README.md      # fenced ```blocks, contents only
node scripts/det/extract.js --json urls < page.html  # JSON array
```

Duplicates removed, first-seen order preserved. Unknown mode exits 2.

## Verifying the library

```bash
node scripts/det/test.js   # runs every script against known input/output
```

Runs fast, no deps. CI-safe. A script is not "done" until it appears here with a
passing test.
