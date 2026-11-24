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

Change on 2026-11-24: after the fourth round raised finds on the seen half,
the person directing the work asked for one more held-out run on the final
branch. So the held-out half has now been run three times. Nothing was tuned
on held-out results between runs, but the earlier looks are a weaker seal
than a never-seen half, and the fourth-round held-out numbers should be read
that way.

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

## Results, 2026-11-24

Quick audit, 8 engine calls per repo at most, local engines (codex hunts,
claude checks), 0 Atris credits. "Before" is the released Sentinel 3.92.1.
"After" is this branch. The exam 1 seen half and this exam's seen half were
used to tune; this exam's held-out half ran once before and once after, with
nothing looked at in between.

What changed in Sentinel:

- When leads outnumber the check calls left, one check call takes up to three
  leads from the same files, so fewer leads are dropped unchecked.
- A quick run that has calls left after its first wave runs a second wave of
  hunters, and areas whose hunter call failed go first.
- The checker counts getting past the project's own control (a redaction, a
  containment check, an access rule) as a gain, even when the reach is narrow.
- A library the repo pins but has not installed is judged from its documented
  behavior at that version instead of being left as a lead.
- Build scripts for retired targets, and holes that need a required setting
  left empty so the product itself fails, are not shipped findings.

| | before | after |
|---|---|---|
| **this exam, seen half (10)** | | |
| found | 2 | 1 (first reported as 2; see below) |
| near | 3 | 2 |
| wrong alarms / confirmed | 2 / 18 (11%) | 8 / 29 (28%) |
| new real holes (private) | 14 | 19 |
| **this exam, held-out half (10)** | | |
| found | 0 | 0 |
| near | 3 | 3 |
| wrong alarms / confirmed | 4 / 18 (22%) | 5 / 23 (22%) |
| new real holes (private) | 14 | 18 |
| **exam 1, seen half (10)** | | |
| found | 6 | 7 |
| wrong alarms / confirmed | 2 / 20 (10%) | 1 / 23 (4%) |

Held-out did not improve. Sentinel still finds none of the 10 held-out holes.

Why, from the after run: on three held-out repos the hunter did spot the
published hole and the checker then dismissed it as a documented operator
setting or as no gain to an attacker (a shared token that lets the caller
name any owner, a region placed raw into a request host, and a language value
that can change a request's host). Before the change, two of those were never
checked at all (the check budget ran out) and one was never spotted. So more
checking reached the holes, and the checker's trust rules turned them away.
That is the next thing to fix, on the seen halves first.

Wrong alarms on this exam's seen half rose from 2 to 8, mostly build files
(an unsigned package mirror, a moving upstream archive, an image label) and
admin or diagnostic ports that are internal by design. More leads were checked
(29 confirmed against 18), and the checker confirmed hardening issues as
holes.

Labels: one reviewer's calls, recorded in `labels.json`. Strict calls are
noted there. A finding on the hole's file that names a different flaw is
`match: other` and does not count as found. New real holes are keyed by hash.

Caveats: one quick run per repo. In about half the after runs some hunter
calls failed and left areas unread (17 failed area checks on the seen half,
21 on the held-out half, against 4 and 6 before), so luck in which areas get
read matters. The exam 1 "before" numbers are the ones recorded for 3.92.1 in
`../real-advisories/README.md`. Kept run copies are in
`~/.atris/sentinel-real-scorecard/runs/` (`2026-11-23T23-22-baseline-3.92.1`,
`2026-11-24T00-01-after2-seen`, `2026-11-24T00-17-after-heldout`).

Correction, made during the second round: the after run's Aegra finding
(stream and wait routes skip the create policy) was first labelled as the
published hole. The published hole is the missing thread owner check, and
the baseline label had already called this finding a different flaw on the
same lines. It is now `match: other`, so the first round found 1, not 2.

## Second round, 2026-11-24

Same exam, seen halves only (this exam's seen 10 and exam 1's seen 10), two
runs per repo (a and b), two repos at a time per exam. The held-out halves
were not run again: the plan was to run each once only after the seen numbers
beat 3.92.1 on both found and wrong alarms, and they do not yet.

What changed in Sentinel:

- A failed reading call now says why (the engine's own error line), gets one
  retry right away, and a refused one is retried on the other installed
  engine. An area still unread marks the run incomplete and is listed under
  "Not read" in the report, so a clean result never covers unread code, even
  when other parts were carried from an earlier run.
- Retries never take the calls held for checking leads or for the critics.
- Leads that claim code execution or account takeover are checked first.
- A checker that waves a spotted hole off must quote the line of this repo
  that shows it. A README, a doc or a comment saying the code is a training
  app, intended or for trusted users only does not count. Without such a
  line the check counts as passed.
- Build and supply-chain hygiene (signature checks off in a build file, a
  moving upstream download) and an admin, metrics or support listener on its
  own port are hardening notes, unless outside input reaches a CI step or the
  same routes answer on the public listener.
- A product shipping a safe and an unsafe variant side by side, with the
  operator picking one, is an operator setting. Making a victim's browser
  load an image any web page could load is no gain.

Why the reads failed: the hunter engine refused some requests with "This
content was flagged for possible cybersecurity risk", not rate limits or
timeouts. The refusals come and go between runs of the same repo.

| | 3.92.1 | first round | round 2 (a / b) | round 3 (a / b) |
|---|---|---|---|---|
| **this exam, seen half (10)** | | | | |
| found | 2 | 1 | 3 / 3 | 1 / 2 |
| wrong alarms / confirmed | 2 / 18 (11%) | 8 / 29 (28%) | 8 / 32 (25%) / 10 / 34 (29%) | 3 / 24 (12%) / 4 / 27 (15%) |
| failed area reads | 4 | 17 | 0 / 8 | 0 / 4 |
| **exam 1, seen half (10)** | | | | |
| found | 6 | 7 | 6 / 5 | 7 / 7 |
| wrong alarms / confirmed | 2 / 20 (10%) | 1 / 23 (4%) | 7 / 29 (24%) / 6 / 28 (21%) | 6 / 29 (21%) / 3 / 20 (15%) |
| failed area reads | n/a | 10 | 0 / 3 | 0 / 3 |

Round 2 had the first five changes; round 3 added the last one and the retry
on the other engine. Round 3 is the current branch.

Reading it plainly: unread areas are mostly gone and are now always named.
Wrong alarms fell back from the first round on this exam but are still a
little above 3.92.1. Exam 1 finds one more hole than 3.92.1 in both runs.
This exam's finds did not move. The seen bar is not met, so no held-out run.

What is left, from the round 3 hand check:

- Four published holes were spotted and then kept as notes on the "needs
  insider access" check: an owner check missing on a thread looked up by a
  random id (Aegra), a signed request that can be replayed once captured
  (Pusher), and two archive escapes where the archive comes from the
  product's own control service. The advisories count all of these as holes.
  The check treats "needs another user's random id" and "needs a captured
  request" as insider-only, a rule added earlier to stop a wrong alarm on a
  payment card id only the victim's browser sees. Loosening it is a call
  about what counts as a hole, so it is left for a person to make.
- Most remaining wrong alarms are kinds the checker is already told to
  dismiss (a user's own tokens in their own notebook, a forwarded-address
  rule the docs call forgeable, a project's own config), and several are
  close calls a looser reviewer would call real.

Labels: rounds 2 and 3 were labelled by a separate reviewer reading the
source, following the earlier labels as precedent. Exam 1's first-round
labels were one reviewer's calls; later rounds were stricter on close calls,
which is part of why exam 1's wrong alarm rate rose. Kept run copies:
`2026-11-24T00-54-pass2-seen` and `2026-11-24T02-04-pass3-seen` in
`~/.atris/sentinel-real-scorecard/runs/`. `2026-11-24T01-57-pass3-seen` was
stopped early to fold in a change and is not a measurement.

## Fourth round, 2026-11-24

One change on top of round 3: a hole whose only barrier is another user's
random id, or a request captured from another user, is no longer dropped as
"insider only". It is confirmed one step lower (never above medium), with the
condition written out, for example "Needs another user's id, which is random
but can leak through links or logs." Published advisories count these as
holes; the lower severity keeps them from posing as serious alarms.

Seen halves: two runs per repo, labelled by the same strict reader as rounds
2 and 3.

| | 3.92.1 | round 3 (a / b) | round 4 (a / b) |
|---|---|---|---|
| **this exam, seen half (10)** | | | |
| found | 2 | 1 / 2 | 4 / 4 |
| wrong alarms / confirmed | 2 / 18 (11%) | 3 / 24 (12%) / 4 / 27 (15%) | 4 / 31 (13%) / 4 / 35 (11%) |
| failed area reads | 4 | 0 / 4 | 0 / 3 |
| **exam 1, seen half (10)** | | | |
| found | 6 | 7 / 7 | 8 / 8 |
| wrong alarms / confirmed | 2 / 20 (10%) | 6 / 29 (21%) / 3 / 20 (15%) | 8 / 31 (26%) / 7 / 30 (23%) |
| failed area reads | n/a | 0 / 3 | 1 / 1 |

Failed reads were retried; only one run (goshs, run b) still ended with
areas unread (3), and that run is marked incomplete with them named.

This exam's seen finds doubled, with wrong alarms flat against round 3 (8 of
66 against 7 of 51 pooled). That met the agreed bar for one held-out run.
Exam 1 also finds one more hole in both runs, but its wrong alarms rose.

Held-out halves, one run each on the round 4 branch:

| | 3.92.1 | first round | round 4 |
|---|---|---|---|
| **this exam, held-out half (10)** | | | |
| found | 0 | 0 | 1 |
| near | 3 | 3 | 3 |
| wrong alarms / confirmed | 4 / 18 (22%) | 5 / 23 (22%) | 10 / 29 (34%) |
| **exam 1, held-out half (10)** | (earlier "after" run) | | |
| found | 4 | | 6 |
| wrong alarms / confirmed | 4 / 18 (22%) | | 9 / 34 (26%) |

Reading it plainly: more published holes are found on both held-out halves
(1 of 10 against 0, and 6 of 10 against 4). Wrong alarms are higher on both.
The held-out wrong alarms are mostly close calls on one theme: a project's
own config file treated as attacker input (four on one repo), where earlier
labels call the repo's config the operator's own setting. One wrong alarm
was correctly lowered to low by the new random-id rule and still judged no
real gain.

Caveats:

- One held-out run per repo. The seen runs show how much a single run moves
  (found 1 against 2 between two runs of the same code in round 3).
- The 3.92.1 and first-round held-out labels were one reviewer's calls; round
  4 used the stricter reader, so part of the rise in wrong alarms is the
  reader, not the tool.
- On this exam's held-out half, three holes were spotted and turned away.
  One (a language or namespace value picking the request host) was filed as
  an operator setting because it needs a custom path template.
- The exam 1 held-out half had been run twice before this work started.

Kept run copies: `2026-11-24T03-04-pass4-seen` and
`2026-11-24T04-03-pass4-heldout` in `~/.atris/sentinel-real-scorecard/runs/`,
each with the label files and score tables.

## Fifth round and one reader for every version, 2026-11-24

Two things, so the comparison is fair.

First, every confirmed finding from 3.92.1, round 4 and round 5 now carries a
label from the same strict reader used since round 2. Before this, 3.92.1 and
the first round were scored with looser labels. The old exam's 3.92.1 run
files were not kept; only its list of 38 confirmed findings (names and the
earlier notes) survives, so the strict reader judged those from the source
without the checker's full reasoning. "Found" below counts an advisory when
a confirmed finding is labelled as its published hole. In one cell (round 4,
this exam, run a) that gives 5 where the scorer's file-and-line check gives
4: the Aegra finding names the missing owner check in the shared function
all three published routes call.

Second, one rule change, checked on the seen halves only, two runs per repo:
the project folder a command-line or developer tool runs in counts as the
operator's own. A settings file there (naming a server, host, user or path)
and its committed files and symlinks are as trusted as the operator, so a
hole that needs only those is insider access. It stays a finding when the
tool's job is to handle folders from people it does not trust (a code
reviewer, a scanner, a bot or CI on outside pull requests, an installer of
third-party packages), or when the file arrives from outside. The rule is
told to the checker only; hunters never see it. The held-out halves were not
looked at or run for this change.

| | 3.92.1 | round 4 (a / b) | round 5 (a / b) |
|---|---|---|---|
| **this exam, seen half (10)** | | | |
| found | 2 | 5 / 4 | 3 / 3 |
| wrong alarms / confirmed | 2 / 18 (11%) | 4 / 31 (13%) / 4 / 35 (11%) | 5 / 30 (17%) / 6 / 35 (17%) |
| **this exam, held-out half (10)** | | | |
| found | 0 | 1 | not run |
| wrong alarms / confirmed | 5 / 18 (28%) | 10 / 29 (34%) | not run |
| **exam 1, seen half (10)** | | | |
| found | 6 | 8 / 8 | 7 / 8 |
| wrong alarms / confirmed | 3 / 20 (15%) | 8 / 31 (26%) / 7 / 30 (23%) | 2 / 18 (11%) / 4 / 25 (16%) |
| **exam 1, held-out half (10)** | | | |
| found | 4 | 6 | not run |
| wrong alarms / confirmed | 4 / 18 (22%) | 9 / 34 (26%) | not run |

3.92.1 is one run per repo. Under the same reader, its wrong alarms move from
11% to 11%, 28% (was 22%), 15% (was 10%) and 22% (was 22%).

What the rule did: little, measured. On exam 1's seen half the repo where
this wrong alarm lives (a command-line tool reading its project's config and
committed symlinks) had 1 such wrong alarm in each round 4 run, and 0 and 2
in round 5. In the run that still confirmed them, the checker named "a
repository contributor" as the attacker and did not apply the rule. Exam 1's
wrong alarms did fall from 25% to 14% pooled, but that came from other repos
(fewer confirmed findings overall), not from this rule. A stronger wording
that says outright that a repository contributor is not a lower-trust
attacker against the person who runs the tool in that repository is the
next thing to try; it was not tried here.

What it did not do: finds fell on both seen halves in round 5. None of the
lost holes was turned away under the new rule. On this exam, the goshs bulk
download and the qbee archive escape were never spotted by a hunter in round
5 (round 3, before the rule, missed both in both runs too). On exam 1, the
Homer hole was lost in one run to reads the engine refused, and the Auth0
hole was left as "needs a fact" about the operator's Auth0 tenant, as it was
in two runs before the rule. This exam's extra wrong alarms are the same
Skipper and goshs kinds seen in round 4, not project folders. So the drop
looks like run-to-run luck, not the rule, and the rule is kept since it cost nothing measurable. That is a
judgment from the records, not a measured difference: two runs per repo
cannot separate a one-hole change from luck.

Kept run copies: `2026-11-24T04-38-pass5-seen` in
`~/.atris/sentinel-real-scorecard/runs/`. The strict label sets, the lists
sent to the reader and this table are in
`~/.atris/sentinel-real-scorecard/strict-relabel-2026-11-24/`.
