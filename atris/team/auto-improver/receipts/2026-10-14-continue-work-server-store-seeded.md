The continue work server check went from about 0.72s to 0.23s. Its parent task now reaches review through the task store instead of three command launches. It passed five runs, a planted bug in the continue work rule failed it on the first server read, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-continue-work-server-store-seeded.md.

Rerunnable verification command:
`/opt/homebrew/bin/node --test --test-name-pattern='^task serve continue-work creates scoped follow-up$' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task serve continue-work creates scoped follow-up (231.632667ms)
✔ task serve continue-work creates scoped follow-up (235.564791ms)
✔ task serve continue-work creates scoped follow-up (231.492042ms)
✔ task serve continue-work creates scoped follow-up (256.336125ms)
✔ task serve continue-work creates scoped follow-up (233.861417ms)
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: nothing to move.
```

Change: the check added a parent task with a goal, readied it, and reviewed it with a next task, all as separate command launches, so the server had a reviewed parent to continue. Those three steps now make the same store calls the commands make. Every server request is unchanged.

Why it is safe: a scratch script ran add, ready and review both ways on fresh stores. Once timestamps, traces and versions were set aside, title, tag, status, claim, workspace, every metadata field, the latest event type and the event count all matched exactly.

Cost: the add and ready commands' title warning and policy gates no longer run for this parent. Other checks cover those commands directly.

Proof the check still bites: the rule that picks continue work when a reviewed task names a next task was patched to always pick waiting on a human. The check failed on the first server read of the parent (expected continue work), right after the seed. The source was restored from git and checked clean.

Metric: three runs before: 717ms, 718ms, 713ms. Five runs after: 231ms to 256ms. Three fewer command launches. All four task server checks now total about 2.6s, down from about 4.9s at the start of this pass.

Map refs: 41 refs shifted 7 lines from the diff, each matched by line content, 0 mismatches.

next_push: Rank the slowest checks in test/commands.test.js outside the task server group and pick the top one that still seeds state with command launches.
layer: capabilities
