The review default screen test now skips the full workspace setup, about 1.02s to 0.82s, and no longer needs a workaround that deleted stale task state setup left behind; it passed three runs, a mutant that showed the old verbose board failed it, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-default-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^review default mode leads with certified accept' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ review default mode leads with certified accept like first-minute (809.924125ms)
✔ review default mode leads with certified accept like first-minute (819.29825ms)
✔ review default mode leads with certified accept like first-minute (853.621709ms)
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Mutation: the review code was patched so the default screen fell through to the old verbose board. The test failed. The source was restored from git and checked clean.

Metric: one init launch removed. Before: 1025ms. Three runs after: 810ms, 819ms, 854ms.

Why it is safe: review treats a folder with no atris folder as brand new and gives the welcome screen instead. The test makes the atris folder, so it still takes the normal review path. The task, claim, ready, and review steps all run against the test's own task store, as before.

Skipped on purpose: the analytics fresh workspace test, the clean fresh init test, the placeholder map test, and the agent doctor test each check what setup itself produces (a starter log with no completions, a placeholder map, agent tool wiring). On a bare folder those checks would pass without testing anything, so they keep setup. Sharing one setup across them by copying was also ruled out: setup writes its own folder path into task state, so a copy would point at the wrong folder.

Commands and artifacts: atris mission status; git status; reading the analytics, verify, agent doctor and review code; one throwaway init to see what it writes; timed runs before and three after; the mutant run and restore; frozen verifier; 4 line refs shifted by a script that matched every old target line, and one ref above the edit checked unchanged; atris doc-health; atris slop detect.

next_push: The setup-removal track is done (the last 7 setup tests check setup itself). Re-time the whole command test file with plain git first on the path, and cut the slowest check left.
layer: capabilities
