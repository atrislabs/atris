# findings, 2026-10-25

> **Read "final exam 3" first.** The sections before it are a dated log. Several of their conclusions, including both numbered lessons under "What we learned", did not hold on the larger pre-registered exam.

Worker: Sonnet 5.5 for every arm. Judge: codex, blind, both orders, a split counts as a tie.

## Result

Version 1.1 passes the decision rule on tasks it never saw, in the setting it is meant for (worker has tools).

| run | skill vs nudge | skill vs plain | nudge vs plain | scope growth (plain / nudge / skill) |
|---|---|---|---|---|
| v1.0, 10 tasks, no tools | 1 - 7 (2 tie) | 2 - 7 (1 tie) | 3 - 3 (4 tie) | 0 / 3 / 6 |
| v1.1, 7 fresh tasks, no tools | 4 - 3 | 3 - 4 | 1 - 5 (1 tie) | 0 / 5 / 0 |
| v1.1, 8 fresh tasks, tools on | **6 - 1** (1 tie) | 4 - 3 (1 tie) | 0 - 6 (2 tie) | 0 / 3 / 3 |

Rule check on the last row: beats nudge (6 to 1), scope flags not above nudge (3 and 3). Pass.

## What we learned

1. **A generic "be ambitious" line made work worse on these sets (contradicted later: it beat plain 32 to 25 in exam 3).** Across both fresh sets it beat plain once in 15 and lost 11 times. The judge's reasons: padding, extra options nobody asked for, and invented claims stated as fact.

2. **The four questions looked like they turned ambition from a cost into a gain (not confirmed by exam 3).** With tools on, the code review actually ran the function on nine inputs and found four real bugs. The SQL answer caught a window bug the plain answer had.

3. **Against plain, it is roughly even (7 to 7 across both fresh sets).** Eight tasks is too few to claim a win over plain. The honest claim is "ambition without the cost", not "better than no ambition".

4. **Version 1.0 stalled.** "Start from the rawest material" made the worker ask for files instead of doing the job (calculus, hiring, slow page). The 1.1 rule, "do the work now, state assumptions, name the one thing to pull", removed the stalls: scope flags went from 6 of 10 to 0 of 7 with no tools.

5. **Without tools, the skill can still break.** Two of seven no-tools answers were fake command calls, because the rewrite says "run it". Use it where the worker can act.

## Still loses on

Short writing where the words are the deliverable: the team note on fast tests, the wedding toast, the support triage plan. The rewrite pulled in data gathering the person did not need. Next test: skip the agency and accuracy questions when the deliverable is prose for a human, and rerun on a fresh writing-only set.

## Harness notes

- Account connectors leak into `claude -p` unless `--strict-mcp-config` is passed; three v1.0 rewrites mention a Drive connector.
- Codex judge hit "model at capacity" twice; `judge.js` now retries and resumes.

# final exam 1, 2026-10-26: v1.3 fails the ship gate

28 fresh tasks written by Haiku, judge pinned to gpt-6-sol at high effort (the account default, gpt-6.1-sol at xhigh, stalled for minutes per call).

```
pass  all pairs judged             84/84
FAIL  1 beats the nudge for real   13 won, 7 lost, 8 tied, p=0.1316
FAIL  2 never worse than plain     10 won, 15 lost, 3 tied, p=0.8852
pass  3 same size job              skill 2, nudge 10, plain 0 of 28
pass  4 writing fixed              4 won, 3 lost, 1 tied, p=0.5000
pass  5 nothing broken             none
```

- Writing stopped losing: 6 to 0 against the nudge and zero scope flags. Against plain it was 4 to 3, which is not significant.
- On the 20 mixed tasks plain beat the skill 12 to 6. The skill won the judgment calls (LLC vs DBA, photo rename script, phone validation, palette contrast, budget) and lost the quick exact asks (invoice math, physics, SUMIF, overdue formula, meeting items, titration), where it added checks nobody asked for. Longer answers also carried more small errors (weekdays, a 5 to 8 km jump).
- The skill already said "skip precise specs", but the rewrite step never applied that to itself.
- Freelance-bio was seen during code review before v1.3, so this exam was not fully blind on that one task.

Next: v1.4 decides first whether the task needs deepening and passes quick exact asks through unchanged. Tested on a second fresh exam under the same gate.

# final exam 2, 2026-10-26: v1.4 passes lines 1 to 5

28 new tasks written blind by Haiku with every earlier topic banned. Same worker, same pinned judge, same gate.

```
pass  all pairs judged             84/84
pass  1 beats the nudge for real   20 won, 6 lost, 2 tied, p=0.0047
pass  2 never worse than plain     14 won, 6 lost, 8 tied, p=0.0577
pass  3 same size job              skill 2, nudge 14, plain 0 of 28
pass  4 writing fixed              6 won, 1 lost, 1 tied, p=0.0625
pass  5 nothing broken             none
info  better than plain claim       not earned (14 won, 6 lost, 8 tied, p=0.0577)
info  nudge vs plain                7 won, 18 lost, 3 tied, p=0.9927
```

- The pass-through step did its job: 13 of 28 tasks went through unchanged, all quick exact asks.
- Line 5 was amended after this run (see README). Under the first wording it failed on three correct short answers; the amendment is logged, not hidden.
- "Better than plain" is still not earned: 14 to 6 sits just above the 0.05 line. Public copy says it won more than it lost, not yet beyond chance.
- The generic "be ambitious" line lost to plain again, 7 to 18.

## Where the wins came from

| exam 2, 28 tasks | vs nudge | vs plain |
|---|---|---|
| 15 deepened (judgment tasks) | 9 won, 4 lost, 2 tied | 9 won, 3 lost, 3 tied |
| 13 passed through unchanged (quick exact asks) | 11 won, 2 lost | 5 won, 3 lost, 5 tied |

On pass-through tasks the skill answer is just a fresh plain answer, so those wins over the nudge come from stepping aside, not from the four questions. The grid-width task shows the worker's own noise: each arm opened with a wrong bold width (plain 84 px, nudge 96 px, skill 82 px) and then worked down to the right 78 px. It was a pass-through, so the skill's answer there is an ordinary plain answer.

## What we can say in public (retracted, see exam 3)

The claims first written here ("be ambitious" hurts, the skill beats it 20 to 6) did not replicate on the larger exam 3 below. They are withdrawn.

# final exam 3, 2026-10-26: v1.4 does not beat no instruction

Pre-registered in README.md and pushed before any data. 60 new tasks written blind by Haiku, skill frozen as shipped in 3.74.18, same worker and pinned judge.

```
pass  all pairs judged             180/180
FAIL  1 beats the nudge for real   26 won, 26 lost, 8 tied, p=0.5551
pass  2 never worse than plain     25 won, 23 lost, 12 tied, p=0.4427
pass  3 same size job              skill 1, nudge 14, plain 0 of 60
pass  4 writing fixed              9 won, 3 lost, 3 tied, p=0.0730
FAIL  5 nothing broken             utm-link-builder
info  better than plain claim       not earned (25 won, 23 lost, 12 tied, p=0.4427)
info  nudge vs plain                32 won, 25 lost, 3 tied, p=0.2135
```

- "Better than plain" is not earned, and per the pre-registration there is no rerun.
- The skill's 20 to 6 lead over the nudge in exam 2 did not hold: 26 to 26 here. On the 38 deepened tasks it went 15 to 13 against plain and 15 to 18 against the nudge.
- The generic nudge beat plain 32 to 25 here, after losing 7 to 14 and 7 to 18 in exams 1 and 2. Across all three: 46 won, 57 lost. That is too unstable to call "ambition hurts".
- The line 5 failure is a correct one-line UTM link (one long word), a false alarm by the under-10-words rule. The rule now flags only fake command calls or blank replies (see README). It does not change the outcome, since line 1 fails anyway.

## What actually holds across all three exams

- **The skill keeps the job the same size.** Scope growth was flagged on 1 to 2 tasks per exam for the skill, against 10 to 14 for the generic line.
- **Writing leans its way.** Against plain on prose tasks: 4 to 3, 6 to 1, 9 to 3. That is consistent, but no single exam clears 0.05, so it is not claimed.
- **Exam 2's lead did not replicate.** One likely reason is that 20 to 30 tasks is too few to separate a small effect from chance. That is a hypothesis, not a finding. Any future claim gets a pre-registered test sized in advance.

## Status

The skill stays in 3.74.18. Against no instruction it showed no proven difference either way (25 to 23, p = 0.44). It grows the job far less than a generic ambition line, and may help with writing. Its file makes no performance claims. Nothing in the package needs pulling.
