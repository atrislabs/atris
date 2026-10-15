The slow test ranking for the commands tests is now measured with plain git, and the lesson behind it is in the shared lessons file with a runnable detector. The required checks passed 35 of 35, exit 0. No test or product code changed this tick.

Files edited: atris/lessons.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-plain-git-slow-test-ranking.md.

What happened: the full commands file (437 checks, all passing, 4m32s) ranked the auto-accept 20-row sweep first at 6.3s. Its setup was already on the task store. Logging every child process showed its time was 20 git repo checks at about 85 ms each, all through the mission's Node git wrapper. With plain git first on PATH the same check took 995ms. A cache I drafted for a different git snapshot turned out not to run in this check at all, so I reverted it rather than ship an unproven change.

Ranking with plain git (the 40 slowest under the wrapper, re-timed; the 10th plain time, 1813ms, beats the 40th wrapper time, 1732ms, so the top 10 is complete):
```text
 1  2732ms  task review-chat extracts only proof-derived verifier commands (18 launches)
 2  2542ms  task backlog and clear-plan demote only planned open tasks (21 launches)
 3  2288ms  task ready holds work in review until human accept (16 launches)
 4  2187ms  task plan and do record an explicit headless stage contract
 5  1981ms  task auto-accept-certified requires explicit human confirmation
 6  1958ms  task page exposes one-task goal chat stage and review actions
 7  1939ms  task review-lane-act executes only safe drain actions and supports dry-run
 8  1879ms  task headless JSON contract supports create, claim, note, finish, and events
 9  1858ms  task review-lane-loop runs bounded safe actions and stops before human accept
10  1813ms  task current-step advances the scoped current task one safe action
```

Rerunnable verification command:
`head -2 "$(command -v git)" | grep -q node && echo wrapper-on-path; node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
wrapper-on-path
ℹ tests 35
ℹ pass 35
ℹ fail 0
verifier exit=0
```

Why it matters: this was the third time today a tick learned the wrapper skews timings. The worktree ship and member run checks also look slow under the wrapper and drop out of the plain top 10. Without the lesson in a shared place, the next tick would likely spend its slice on wrapper cost again.

Cost: one full file run and one 40-check rerun of measurement, with no speedup shipped this tick.

next_push: Cut the 21 command launches in the backlog and clear-plan check (2.5s with plain git), moving the ones that only seed planned or claimed rows to the task store.
layer: beliefs
