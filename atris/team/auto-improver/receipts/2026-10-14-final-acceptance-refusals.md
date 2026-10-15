# Final acceptance refusals run together

The guard test runs its final two refusal checks together; four changed focused runs and all 35 required checks passed, exit 0.

- Task: AIC-6
- Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.
- Change: two real CLI calls overlap after zero-reward review, with every exit, reason, final status and pending approval assertion retained. Eight launches now take five turns instead of six.
- Safety: accept opens the store and resolves the task before refusing, without task writes. Automatic-accept has explicit confirmation and actor, skips standing-policy lookup and refuses before opening the store. The final show waits for both.
- Focused command: `node --test --test-name-pattern='^task proof-only agent env blocks acceptance verbs$' test/commands.test.js`
- Before wall milliseconds: [1061, 1065, 1089, 1062], four exit 0.
- After wall milliseconds: [961, 950, 949, 984], four exit 0.
- Metric: mean wall runtime fell from 1069.25ms to 961.00ms, 10.1% in this local sequential sample, not a guarantee under load.

Actual final focused output:
```text
✔ task proof-only agent env blocks acceptance verbs (784.732084ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 921.122875
exit 0
```

Required command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Actual required output excerpt:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 13340.205791
exit 0
```

Navigation and bookkeeping: atris brain activate --root . --verify (plan only, exit 2; generated brain files absent); atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json (no candidate); atris task list --status open; atris task new; atris task claim AIC-6 --as auto-improver; atris task note AIC-6; git diff --check; atris task ready AIC-6; atris brain compile --root .; git add (declared files only); git commit; git push.

Existing changes in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md were preserved and excluded. Ready uses /opt/homebrew/bin/node to match the direct runtime because the login shell otherwise selects Node 20 without node:sqlite.

next_push: inspect the single approval test for independent post-certification read-only checks that can overlap safely.
layer: capabilities
