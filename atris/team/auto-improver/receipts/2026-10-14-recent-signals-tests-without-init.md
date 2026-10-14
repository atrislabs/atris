The two recent signals tests now skip the full workspace setup, about 1.33s to 0.65s together; both passed three runs, a mutant that broke the empty value and the lesson cap failed both, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-recent-signals-tests-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^getRecentSignals' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ getRecentSignals returns empty commit/wiki/lesson signals when sources are missing (96.07575ms)
✔ getRecentSignals reads recent git commits, wiki health, and last 10 lesson lines (560.31825ms)
ℹ fail 0
verifier_exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: 1115 right, 0 moved, 3 unclear, 0 gone
```

Mutation: the signals code was patched so a missing wiki status gave an empty string and every lesson line came back. Both tests failed. The source was restored from git and checked clean.

Metric: two init launches removed. Before, both tests together: 360ms + 966ms. Three runs after: 93+557ms, 97+551ms, 96+560ms. Most of what is left is the real git commit the second test needs.

Why it is safe: the function reads only git history, the wiki status file, and the lessons file. The empty test used to run setup and then delete those two files; it now makes the wiki folder so only the files are missing. The full test now writes both files before the seed commit, since the commit needs something to hold; the checks did not change.

Doc health: the 3 unclear refs are the same on the unchanged branch head, checked in a throwaway checkout.

Commands and artifacts: atris mission status; git status; reading the signals function; timed runs before and three after; the mutant run and restore; frozen verifier; 24 line refs shifted by a script that matched every old target line (0 mismatches); atris doc-health; atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 8; the analytics fresh workspace test and the clean fresh init test are the next to check.
layer: capabilities
