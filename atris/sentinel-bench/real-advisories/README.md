# Sentinel real-advisory scorecard

The practice exam (`atris sentinel bench`) uses small made-up repos. This one
uses 20 real, published security holes in real open-source code, so the score
says how Sentinel does on code nobody wrote for it.

Each hole has a GitHub Security Advisory, a public fix commit, and the commit
just before the fix (the vulnerable commit). Sentinel reviews the vulnerable
commit. It does not see the fix or the advisory.

## The list

`advisories.json` holds the 20. It was frozen before any Sentinel run. Fields:
advisory id and link, CVE, repo, vulnerable commit, fix commit, the hole's
file and line (plus `also`, other lines that are part of the same hole), and a
one-line plain description.

What they cover, matching what Sentinel says it catches:

| class | count | advisories |
|---|---|---|
| broken access checks / IDOR | 4 | GHSA-w89x-c962-c44g, GHSA-588f-fvcv-xhvf, GHSA-89vx-jh4q-vg3w, GHSA-5g9x-qwh5-33x4 |
| sign-in account matching | 3 | GHSA-rrvg-cxh4-qhrv, GHSA-wv4w-6qv2-qqfg, GHSA-8cfq-jgf7-8m27 |
| database permission rules (Supabase RLS) | 1 | GHSA-9x83-rrg6-9pr9 |
| webhook or header trust | 3 | GHSA-3fcr-jvgp-7f58, GHSA-wchh-mrv2-5h4q, GHSA-5p54-whvp-x327 |
| secrets exposed to users | 2 | GHSA-q4gh-4ffp-5cg8, GHSA-pfvc-3p5h-x7h6 |
| injection | 2 | GHSA-f46q-3v67-fmm4, GHSA-jq3q-62jc-fqq9 |
| SSRF | 2 | GHSA-ch3g-4xvr-674q, GHSA-45gf-fjxp-cjpq |
| path traversal | 2 | GHSA-62gx-5q78-wrvx, GHSA-4g5x-hcwm-82jw |
| unsafe agent tool use | 1 | GHSA-2xhg-73j7-rrgx (also GHSA-jq3q and GHSA-45gf are agent tools) |

Languages: 8 Go, 6 Python, 5 TypeScript/JavaScript, 1 SQL. Every repo is under
3,000 tracked files at the vulnerable commit (52 to 2,839).

How they were picked: GitHub's advisory database, reviewed advisories from
2024-06 to 2026-11 in npm, pip and Go, filtered to those CWE classes, to
exactly one fix commit link in the same repo, and to repos under 60 MB. From
those, web apps, APIs and agent tools were preferred over libraries, and fixes
whose diff pins the hole to a few lines were preferred over large rewrites.
One exception: no RLS advisory links a fix commit, so for GHSA-9x83 the fix
commit is the one that closed the direct insert path, found by reading the
repo history (`fix_note` says so).

## Seen and held-out

Rule, written before any run: sort the 20 by advisory id as plain text. The
1st, 3rd, 5th and so on are **seen**; the 2nd, 4th, 6th and so on are
**held-out**. The `split` field records the result.

Use the seen half when changing Sentinel. Check the held-out half only to
confirm a change, never to tune it. These advisories are public, so the
held-out half is held out by discipline only: anyone can read them.

## Scoring

- **FOUND**: a confirmed finding points at the same hole: same file, same
  flaw, line within 30 of the hole or an `also` line.
- **NEAR**: the spot shows up only as an unchecked lead (needs validation), a
  rejected finding, or a hardening note.
- **MISSED**: nothing on that spot.

Every other confirmed finding is a candidate wrong alarm. Each one is checked
by reading the code at the vulnerable commit and labelled `real` (a new hole,
never reported anywhere) or `wrong`.

"Same flaw" and "real or wrong" are human calls. They live in `labels.json`,
keyed by advisory id and finding fingerprint. The script matches file and line
by itself and shows `FOUND?` for a confirmed finding on the spot that nobody
has labelled yet, and `unchk` for confirmed findings elsewhere not yet labelled.

For each miss the script says why, from the run's coverage ledger:

- **never read the file**: no reviewed area included it
- **queued the file but never read it**: an area held it but ran out of budget
- **read the file but did not see it**: a hunter read it, nothing came back
- **saw it and dismissed it**: a finding on the spot was rejected

## Running it

```
node scripts/sentinel-real-scorecard.js fetch     # clone the 20 vulnerable commits
node scripts/sentinel-real-scorecard.js run       # quick audit on each, local engines
node scripts/sentinel-real-scorecard.js score     # print the table
```

`run` takes advisory ids to run a subset, and `--fresh` to replace earlier
runs. Clones go to `/tmp/sentinel-scorecard/repos/<id>`, runs to
`/tmp/sentinel-scorecard/runs/<id>` (`--root` changes the folder).

Each run is `atris security-review audit --quick --no-upload --engine local`
from this checkout, with the clone as the working folder: codex hunts, claude
verifies and critiques, 8 engine calls, no Atris credits.

The clones are untrusted. The script only uses git to fetch and check out
(hooks off, LFS off) and never runs, installs, builds or tests anything from
them. It refuses a clone that carries agent settings able to run commands
when an engine starts there (`.mcp.json`, claude hooks or MCP settings, codex
config). Two clones carry harmless agent files: GHSA-62gx has a claude
permissions list (no hooks), GHSA-9x83 has a Codex app environment file and a
Cursor MCP list, neither of which `codex exec` or `claude -p` reads.
