# findings, 2026-10-25

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

1. **A generic "be ambitious" line makes work worse.** Across both fresh sets it beat plain once in 15 and lost 11 times. The judge's reasons: padding, extra options nobody asked for, and invented claims stated as fact.

2. **The four questions turn ambition from a cost into a gain over that line.** With tools on, the code review actually ran the function on nine inputs and found four real bugs. The SQL answer caught a window bug the plain answer had.

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

- Writing is fixed: 6 to 0 against the nudge, 4 to 3 against plain, zero scope flags.
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
- "Better than plain" is still not earned: 14 to 6 sits just above the 0.05 line. Public copy says "never worse than plain".
- The generic "be ambitious" line lost to plain again, 7 to 18.

## Where the wins came from

| exam 2, 28 tasks | vs nudge | vs plain |
|---|---|---|
| 15 deepened (judgment tasks) | 9 won, 4 lost, 2 tied | 9 won, 3 lost, 3 tied |
| 13 passed through unchanged (quick exact asks) | 11 won, 2 lost | 5 won, 3 lost, 5 tied |

On pass-through tasks the skill answer is just a fresh plain answer, so those wins over the nudge come from stepping aside, not from the four questions. The grid-width task shows the worker's own noise: all three arms opened with the same wrong 82 px and corrected to 78 px.

## What we can say in public

Telling a model "be ambitious" made its work worse: across both final exams it beat no instruction 14 times and lost 32.

The skill decides first. On quick exact asks it steps aside; on judgment tasks it asks four questions and rewrites the task. On fresh tasks it beat the generic line 20 to 6 (p = 0.005) and grew the job on 2 of 28 tasks against 14.

Against no instruction it won more than it lost, 14 to 6, which is not yet beyond chance (p = 0.058). On the 15 tasks it deepened, the four questions won 9, lost 3, tied 3. We do not claim it beats no instruction until a larger run clears p = 0.05.
