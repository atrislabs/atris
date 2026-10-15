# Review-debt selection setup

Ownership setup uses one fewer CLI launch; the focused selection test and all 35 frozen checks passed, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Change: call production `taskStore.claimTask` inside the existing fixture connection, assert successful ownership, and close before CLI readiness. Every readiness and next-selection assertion remains. No product code changed.

Metric: three CLI launches become two. One before sample: 444.693333ms; one after sample: 324.880083ms, about 27% less locally. These single samples are indicative, not a stable benchmark.

Focused command, before and after:
`node --test --test-name-pattern='^task next surfaces review debt when no open work exists$' test/commands.test.js`

Actual after output:
```text
✔ task next surfaces review debt when no open work exists (324.880083ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 476.7985
exit 0
```

Frozen verify command:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Actual output excerpt:
```text
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14328.291417
exit 0
```

Bookkeeping commands: git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris task list; atris brain activate --root . --verify; atris mission goal --json (no candidate); atris; atris task new; atris task claim AIC-11 --as auto-improver; atris task note AIC-11; git diff --check (exit 0); atris task ready AIC-11 --verify with the focused command above using /opt/homebrew/bin/node; atris brain compile --root . (exit 2, plan only); git add declared files; git commit; git push.

First readiness attempt executed the focused check successfully but refused the landing sentence. Retried with a plain developer outcome; focused check passed again, task is in Review. Readiness proof: `atris/runs/2026-10-15-task-aic-11-2026-10-15T02-47-05-492Z.json`. Automatic acceptance remains gated because the absolute Node path cannot be automatically certified. Existing edits in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md are excluded from the commit.

Lesson: a selection test can seed ownership through the real store while retaining the CLI transitions that establish and surface review debt. Do not remove claim launches from tests that assert claim behavior.

next_push: inspect the human-only certified review fallback test for a setup-only ownership launch while preserving certification and selection assertions.
layer: capabilities
