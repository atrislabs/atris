# Sentinel real-advisory exam 2

A second, fresh set of 20 published security holes. The first exam
(`../real-advisories/`) has been used to tune Sentinel and its held-out half
has been looked at, so it no longer counts as a clean test. This one was
frozen (committed) before any Sentinel run on it.

Scoring, the seen and held-out discipline, and the private handling of new
holes are the same as the first exam; see `../real-advisories/README.md`.

## How the 20 were picked

The same written rules as exam 1, done by a script so nobody, and no model,
chose which advisory fills a slot. Everything is in `picker/`.

One. `harvest.cjs` reads GitHub's reviewed advisories published 2024-06-01 to
2026-11-23 in npm, pip and Go, for the same CWE classes as exam 1, keeping
those with exactly one fix commit link in the advisory's own repo. It pages
through every result (exam 1 read only the first 100 per query): 2,486
candidates (`candidates.tsv.gz`, repo facts in `repos.tsv.gz`).

Two. `select.cjs` walks the candidates in a fixed order nobody chose (sha256 of
`sentinel-exam-2:` plus the advisory id) and gives each slot to the first
candidate that passes every rule:

- not in exam 1, and not from a repo exam 1 used; one advisory per repo
- not a duplicate or withdrawn advisory
- repo under 60 MB, not archived, written in Go, Python, TypeScript or
  JavaScript
- its CWE tags fall in exactly one of our classes, and its title names that
  kind of flaw (a CWE tag alone is too broad)
- the fix commit has one parent and changes at most 4 non-test code files
  and 120 non-test code lines, so it pins the hole to a few lines
- under 3,000 tracked files at the vulnerable commit
- web apps, APIs and agent tools first: a first pass takes only repos whose
  name, description or topics say app, server, API, MCP and the like, and do
  not say library, SDK or framework; a second pass takes the rest only if the
  first ran dry
- language caps matching exam 1's mix: at most 8 Go, 6 Python, 6 TS/JS

`select.log` lists every candidate the walk looked at and why it was skipped.

Three. A person read each picked fix commit and wrote down the hole's file and
line (`pins.json`; `makeexam.cjs` turns the patterns into line numbers from the
vulnerable-commit clone). One pick was rejected at this step, because its
linked fix commit does not touch the hole (`reject.json`); the walk then gave
its slot to the next candidate in order. Rejecting it freed a Go slot, so
the language caps moved one JavaScript pick out and one Go pick in.

Differences from exam 1, stated plainly:

- **No database permission rule (RLS) slot.** No reviewed advisory in the
  date range names row level security with a fix commit in a repo exam 1 did
  not use (`rls.cjs` searched every advisory's text). That slot went to access
  control, which now has 5.
- Language is the hole file's language. Hole files: 7 Go, 6 Python, 4
  TypeScript, 3 JavaScript (one Go repo's hole is in its TypeScript worker).
- Two picks came from the second pass (the fastify and hono web frameworks),
  because the first pass ran out of web apps for the header-trust slots under
  the caps. Some first-pass picks are still libraries whose description did
  not say so (simple-git, the i18next loader, Jupyter Server's file helper).

| class | count | advisories |
|---|---|---|
| broken access checks / IDOR | 5 | GHSA-5gpm-rgj3-9q76, GHSA-c9w5-qp6m-m395, GHSA-f8c7-rwf9-fmgm, GHSA-m98r-6667-4wq7, GHSA-rmxw-pq4x-3fvh |
| sign-in | 3 | GHSA-4g9m-rffv-h6wq, GHSA-9q47-3cm2-2rp8, GHSA-v667-gc2r-2xm7 |
| webhook, signature or header trust | 3 | GHSA-3m5p-2c4r-xxw2, GHSA-mw3h-qjxj-6xg9, GHSA-xgm2-5f3f-mvvc |
| secrets exposed | 2 | GHSA-h5gx-45rj-2h5j, GHSA-hrw6-wg82-cm62 |
| injection | 2 | GHSA-jcxm-m3jx-f287, GHSA-xgjr-7j9q-2h4r |
| SSRF | 2 | GHSA-6mwv-4mrm-5p3m, GHSA-xvq9-wjp8-hwqf |
| path traversal | 2 | GHSA-7j4w-x8x8-5mvg, GHSA-vx32-xf7g-9ghr |
| unsafe agent tool use | 1 | GHSA-hxpf-9xvq-wph8 |

Repos have 74 to 1,974 tracked files at the vulnerable commit.

## Seen and held-out

Same rule as exam 1, written before any run: sort the 20 by advisory id as
plain text; the 1st, 3rd, 5th and so on are **seen**, the 2nd, 4th, 6th and
so on are **held-out**. The `split` field records it.

The held-out half is run twice in total: once on the released Sentinel for
the baseline, and once at the end on the changed Sentinel. Nobody looks at
held-out findings or misses between those two runs, and nothing is re-tuned
after the second.

## Running it

```
node scripts/sentinel-real-scorecard.js fetch --exam real-advisories-2
node scripts/sentinel-real-scorecard.js run --exam real-advisories-2 --jobs 4
node scripts/sentinel-real-scorecard.js score --exam real-advisories-2
```

Clones go to `/tmp/sentinel-scorecard/real-advisories-2/repos`. Every run is
also copied to `~/.atris/sentinel-real-scorecard/runs/<date-time>/<exam>/`
so findings can be hand-checked later; `score --runs <that folder>` scores a
kept copy.

Six clones carry agent instruction files (`AGENTS.md`, `CLAUDE.md`). The
audit's engines may read them. They cannot run commands, and the script still
refuses clones with hooks or MCP settings.
