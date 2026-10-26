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
