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
never reported anywhere) or `wrong`. The bar for `real`: someone gains access
or power they should not have, under the project's own trust model. So a
secret written to the operator's own log is `wrong` (the operator already
holds everything), and so is a setting only a fully trusted party can change.

New real holes stay private. This repo is public, so `labels.json` keys a
`real` finding by a hash of its fingerprint, and its note says only that a
real hole exists. The score prints the hash, not the finding, unless you pass
`--show-real` (local use only). The full notes live outside the repo.

"Same flaw" and "real or wrong" are human calls. They live in `labels.json`,
keyed by advisory id and finding fingerprint. The script matches file and line
by itself and shows `FOUND?` for a confirmed finding on the spot that nobody
has labelled yet, and `unchk` for confirmed findings elsewhere not yet labelled.

For each miss the script says why, from the run's findings and coverage
ledger. The audit works in units of (area, kind of flaw), so reading a file
while hunting secrets is not the same as reading it while hunting access bugs.

- **spotted it, then ran out of budget before checking it**
- **spotted it, left it as a lead that needs a fact**
- **saw it and dismissed it**: a finding on the spot was rejected
- **read the file for this kind of flaw but did not see it**
- **read the file only for other kinds of flaw**, and the check for this kind
  was either queued but not run (budget) or never queued at all
- **queued the file for this kind of flaw, never read it (budget)**
- **never read the file**

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
verifies, 8 engine calls, no Atris credits.

The clones are untrusted. The script only uses git to fetch and check out
(hooks off, LFS off) and never runs, installs, builds or tests anything from
them. It refuses a clone that carries agent settings able to run commands
when an engine starts there (`.mcp.json`, claude hooks or MCP settings, codex
config). Two clones carry harmless agent files: GHSA-62gx has a claude
permissions list (no hooks), GHSA-9x83 has a Codex app environment file and a
Cursor MCP list, neither of which `codex exec` or `claude -p` reads.

## Results after the coverage and checker changes, 2026-11-23

Same 20 repos, same quick budget (8 engine calls per repo at most), local
engines, 0 Atris credits. The seen half was used to tune; the held-out half
ran once, at the end, with the final code.

What changed in Sentinel:

- A quick review ranks areas by the kinds of code where published holes
  cluster (routes taking an id, webhooks, sign-in, permission rules, files,
  admin settings, tools a model calls, code that fetches a url), and puts the
  file with the strongest clue first in each area.
- One hunter checks a shared file for every kind of flaw that seeded it, so
  a quick run reads about twice as many areas for the same calls.
- The quick critic call is gone (its proposals were always deferred); that
  call checks one more lead. Leads are checked worst first.
- Hunters get vulnerable and safe examples for webhook signatures, forwarded
  client addresses, database permission rules, unverified email sign-in,
  ownership checks, model-chosen hosts and whole-config template lookups.
- The checker treats the operator, the owner, an admin control service and a
  project the tool already runs as trusted, and looks up facts the repo can
  answer instead of leaving them as leads.

| | seen before | seen after | held-out before | held-out after |
|---|---|---|---|---|
| found | 0 | 6 | 3 | 4 |
| near | 2 | 4 | 1 | 2 |
| missed | 8 | 0 | 6 | 4 |
| wrong alarms | 0 | 2 | 4 | 4 |
| new real holes (private) | 1 | 12 | 3 | 8 |
| engine calls | 69 | 77 | 70 | 68 |

"Seen before" is master with the owner-and-test-code checker change already
in (one fresh run per repo); the older table below predates that change.
"Held-out before" is the older run. Confirmed findings after the change: 38
in all (20 seen, 18 held-out). 12 point at an advisory's hole (10 holes), 20
are real holes nobody has published, and 6 are wrong: 16 percent wrong, down
from 48. On the held-out half wrong alarms stayed at 4 while real findings
went from 3 found and 3 new to 4 found and 8 new.

Label calls for this run: a finding on the hole's file that names a
different flaw gets `match: other` and is scored like any other finding.
Match labels may be keyed by hash so a new hole on the spot is never named.
Two wrong labels are strict judgment calls (a documented Globus username
mapping, and a review tool posting where a steered model asks).

## Results, 2026-11-23 (before)

Sentinel at version 3.90.7 (master at e1316b4aa), quick audit, local engines:
codex hunts, claude checks and critiques. 8 engine calls per repo at most, 141
in all, 0 Atris credits. Each run took 2 to 8 minutes. Six runs ended with
leads left unchecked because the check budget ran out.

| | seen (10) | held-out (10) | all (20) |
|---|---|---|---|
| found | 0 | 3 | 3 |
| near | 1 | 1 | 2 |
| missed | 9 | 6 | 15 |
| wrong alarms | 6 | 4 | 10 |
| new real holes (private) | 4 | 3 | 7 |

Sentinel confirmed 21 findings in all. 4 point at an advisory's hole (3
holes; one hole drew two findings), 7 are real holes nobody has published, and
10 are wrong. So 10 of 21 confirmed findings are wrong (48 percent), one wrong
alarm every two repos.

| advisory | split | class | result | wrong | new | areas read | why |
|---|---|---|---|---|---|---|---|
| GHSA-2xhg-73j7-rrgx | seen | agent tool | MISSED | 1 | 0 | 3/20 | read the file only for other kinds of flaw; the path check was queued, not run |
| GHSA-45gf-fjxp-cjpq | seen | SSRF | MISSED | 0 | 1 | 3/9 | never read the file |
| GHSA-588f-fvcv-xhvf | seen | access | MISSED | 0 | 0 | 3/15 | never read the file |
| GHSA-5p54-whvp-x327 | seen | webhook/header | MISSED | 0 | 0 | 4/53 | read the file for this kind of flaw but did not see it |
| GHSA-89vx-jh4q-vg3w | seen | access | MISSED | 0 | 0 | 4/35 | never read the file |
| GHSA-9x83-rrg6-9pr9 | seen | RLS | MISSED | 1 | 0 | 3/87 | read the file for this kind of flaw but did not see it |
| GHSA-f46q-3v67-fmm4 | seen | injection | NEAR | 0 | 1 | 4/73 | spotted it, then ran out of budget before checking it |
| GHSA-pfvc-3p5h-x7h6 | seen | secrets | MISSED | 1 | 2 | 4/29 | never read the file |
| GHSA-rrvg-cxh4-qhrv | seen | sign-in | MISSED | 1 | 0 | 3/14 | read the file for this kind of flaw but did not see it |
| GHSA-wchh-mrv2-5h4q | seen | webhook/header | MISSED | 2 | 0 | 4/38 | read the file for this kind of flaw but did not see it |
| GHSA-3fcr-jvgp-7f58 | held-out | webhook/header | MISSED | 0 | 0 | 4/15 | read the file only for secrets; never queued it for access |
| GHSA-4g5x-hcwm-82jw | held-out | traversal | MISSED | 0 | 2 | 3/25 | read the file only for other kinds of flaw; the path check was queued, not run |
| GHSA-5g9x-qwh5-33x4 | held-out | access | MISSED | 0 | 1 | 4/9 | read the file only for page injection; never queued it for access |
| GHSA-62gx-5q78-wrvx | held-out | traversal | MISSED | 0 | 0 | 2/14 | read the file only for other kinds of flaw; the path check was queued, not run |
| GHSA-8cfq-jgf7-8m27 | held-out | sign-in | FOUND | 1 | 0 | 2/27 | |
| GHSA-ch3g-4xvr-674q | held-out | SSRF | MISSED | 0 | 0 | 3/19 | read the file only for other kinds of flaw; never queued it for outbound requests |
| GHSA-jq3q-62jc-fqq9 | held-out | injection | FOUND | 1 | 0 | 4/11 | |
| GHSA-q4gh-4ffp-5cg8 | held-out | secrets | FOUND | 0 | 0 | 3/26 | |
| GHSA-w89x-c962-c44g | held-out | access | MISSED | 2 | 0 | 3/30 | read the file for this kind of flaw but did not see it |
| GHSA-wv4w-6qv2-qqfg | held-out | sign-in | NEAR | 0 | 0 | 2/4 | spotted it, left it as a lead that needs a fact |

What the misses say, most common first:

- **Coverage is the main limit: 10 of the 15 misses.** A quick run reads 2
  to 4 areas. On 10 misses the right check never ran on the hole's file: 4
  never read the file at all, and 6 read it only while hunting a different
  kind of flaw (3 of those had the right check queued but out of budget, 3
  never queued it). The bigger the repo, the worse it gets (3 of 87 areas on
  Capgo).
- **Read it and still missed it: 5.** The webhook and header trust holes
  (anycable, ezbookkeeping), the RLS policy in a 28,000-line migration
  (Capgo), the unverified-email sign-in (oauthenticator Auth0), and the
  missing ownership check (cloudreve) were in files a hunter read for the right
  kind of flaw.
- **Spotted but not confirmed: 2.** Homer's raw SQL endpoint was found and
  then dropped by the check budget. social-app-django's account match was
  found exactly but left as a lead.

What the wrong alarms say: 5 of the 10 are secrets written to the operator's
own logs (request URLs, sign-in state). The rest are child processes
inheriting the server's own environment, a dev-only launcher script, a
documented self-host setting, a setting only the trusted panel can change, and
a user's own tokens reaching that user's own notebook. Teaching
the checker that the operator's log and fully trusted settings are not an
attacker would remove most of them.

Caveats: one quick run per repo, so luck in which areas get picked matters;
"same flaw" and "real or wrong" are one reviewer's calls, written down in
`labels.json`; the GHSA-9x83 fix commit is inferred (see `fix_note`).
