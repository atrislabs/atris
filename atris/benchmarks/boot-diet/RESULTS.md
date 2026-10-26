# Boot diet: what agents load, what they use, and what can go

Run 2026-10-25 and 2026-10-26 on the agents-v1 tasks (all 28), in fresh
folders under /tmp, scored by each task's own check.js. Raw rows are in
`raw/`. Every run is one line with the arm, task, pass, seconds, tokens, and
which Atris boot files the agent opened.

## The short answer

Codex agents read the whole Atris rulebook before every job, and it did not
make them better. A shorter AGENTS.md that points to the long form instead
of telling agents to read it scored the same and used about half the tokens
and half the time.

Claude agents barely look at the boot files, so this change does not touch
them. One line in the Claude boot does make Claude worse on one task; that
finding is below and is not changed here.

## Boot tokens, before any work

What an engine loads in a fresh project before it does anything, measured as
the input tokens of one "reply ok" call (`scripts/boot-tokens.js`), with the
user's own settings and skills left out so this is what a new user sees.

| engine | no Atris | Atris on master | Atris lean (this change) |
|---|---|---|---|
| Codex (gpt-6.1-sol) | 15,721 | 19,433 (+3,712) | 16,974 (+1,253) |
| Claude Code (Opus 5.5) | 16,846 | 21,775 (+4,929) | 21,776 (unchanged) |

AGENTS.md went from 14,809 to 5,048 characters. Codex boot cost from Atris
fell by 66 percent.

The Claude boot is 3,723 tokens of skill listing (43 skills), 388 tokens of
hook output, and about 800 tokens of CLAUDE.md and slash commands. Codex
does not see the Atris skills.

The "90k" figure does not describe a fresh project's boot. The real cost
shows up during the job: master's AGENTS.md tells Codex to read FOR_AGENTS,
PERSONA, atris.md, and MAP first (about 47k characters), and that text then
rides along in every later turn. Over a task that added about 150k input
tokens per Codex run (table below).

## What agents actually open

Two sources: 14 days of real transcripts on this machine
(`scripts/boot-usage.js`, `raw/boot-usage-14d.json`), and every lab run.

Real transcripts, share of sessions that touched each file:

| file | Claude member workers (764) | Claude direct (794) | Codex member workers (616) | Codex direct (71) |
|---|---|---|---|---|
| atris/MAP.md | 12% | 15% | 90% | 75% |
| atris/atris.md | 0.3% | 2.5% | 46% | 56% |
| atris/PERSONA.md | 0% | 0.8% | 34% | 38% |
| atris/FOR_AGENTS.md | 0% | 0.4% | 34% | 27% |
| AGENTS.md | 1% | 4% | 20% | 37% |
| CLAUDE.md | 0.5% | 4% | 17% | 32% |
| atris/skills files | 0% | 6% | 10% | 16% |
| `atris guide` | 0.1% | 0% | 0% | 0% |

In the lab, Codex on master opened atris.md, MAP, FOR_AGENTS, and PERSONA
in 54 of 54 scored runs, then often created, claimed, and closed an Atris
task for a two-line fix. With the lean AGENTS.md it opened none of them on
any task; it ran the boot command and did the job.

Claude opened no boot files in 108 of 112 lab runs on either version.

## Scores

Pass counts leave out runs where the engine itself failed (model at
capacity), which says nothing about the agent. Those are listed.

### Round one: Codex, gpt-6.1-sol, medium effort, 28 tasks x 2

| arm | passed | engine failures left out | avg seconds | avg input tokens |
|---|---|---|---|---|
| no Atris | 54/56 | 0 | 28 | 70,175 |
| Atris master | 52/54 | 2 | 65 | 218,531 |
| Atris lean | 53/55 | 1 | 38 | 92,694 |

Paired by task and rep, lean used fewer tokens than master in 52 of 52
pairs (median 41 percent of master) and was faster in 46 of 52.

### Round one: Claude Code, Opus 5.5, 28 tasks x 2

| arm | passed | avg seconds | avg input tokens |
|---|---|---|---|
| no Atris | 54/56 | 19 | 66,232 |
| Atris master | 52/56 | 25 | 99,842 |
| Atris lean | 52/56 | 24 | 99,228 |

### Final head-to-head: lean vs master, fresh seeds, 28 tasks x 2

| engine | master | lean | lean tokens vs master | lean time vs master |
|---|---|---|---|---|
| Codex, gpt-5.6-terra | 54/56, 75s, 251,897 tokens | 54/56, 37s, 110,866 tokens | fewer in 55 of 56 pairs, median 55% | faster in 44 of 56 pairs, median 50% |
| Claude Code, Opus 5.5 | 52/56, 17s, 103,540 tokens | 52/56, 16s, 100,709 tokens | same | same |

The first Codex final on gpt-6.1-sol was stopped after 14 runs because the
model was at capacity and runs stalled near the 10 minute mark; its rows are
kept in `raw/codex-final-aborted-sol-capacity.jsonl`. The final was rerun on
gpt-5.6-terra, so the lean boot was checked on two Codex models.

Every miss in every arm is one of three tasks:
28-phantom-red fails for every arm and engine; 16-add-json-flag fails for
Claude with any Atris boot; the rest are single misses spread across arms.

### Member stack check

`atris member run` on the 10 default lab tasks, one run each, with the
user's normal engine setup (`raw/member-final.jsonl`). Master 9/10 at 243s
average, lean 9/10 at 262s. Both missed 16-add-json-flag. Member time is
mostly the member machinery, and ten runs cannot separate a 20 second
difference from noise, so this check only says the lean boot did not break
members.

## Does the boot make agents better?

On these 28 tasks, no. Bare agents scored as well or better on both engines
(Codex 54/56, Claude 54/56) and were fastest. The tasks are coding jobs, so
this measures cost and harm, not the parts of Atris that only matter across
sessions (tasks, missions, memory).

## The finding not changed here: one line makes Claude gold-plate

Claude with any Atris boot adds an extra field to the --json output on
16-add-json-flag; bare Claude does not. Removing one boot piece at a time on
that task (`raw/claude-t16*.jsonl`):

| boot | passed on task 16 |
|---|---|
| no Atris | 11/13 |
| any boot that keeps the Ambition line | 5/33 |
| full boot minus the four operating rules in CLAUDE.md | 5/6 |
| full boot minus only the Ambition line | 5/6 |
| full boot minus skills | 1/6 |
| full boot minus hooks | 1/6 |

The line is "Ambition. Always one more level. When the goal has a clear
check, go for the bigger version or the great task." Codex with the same
line passed task 16 every time. The four values are an owner decision, so
this change leaves them in place; rewording that line so it never widens a
job with an exact spec is the suggested next step.

## Reproduce

```bash
mkdir -p /tmp/cli-master && git archive origin/master | tar -x -C /tmp/cli-master
node scripts/member-lab.js --lab /tmp/boot-lab --label codex-ab --engine codex \
  --clean-home --tasks all --reps 2 --jobs 3 \
  --arms "master=boot:/tmp/cli-master/bin/atris.js,lean=boot:bin/atris.js,bare=bare"
node scripts/boot-tokens.js --engine codex --cli bin/atris.js
node scripts/boot-usage.js --days 14
```

Swap `--engine claude` for the Claude arms. `--summary` reprints a finished
run. Test a cut before building it with `name=boot:<cli>@<script.js>`.
