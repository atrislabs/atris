# Proof-only refusal checks run together

The proof-only guard test runs three independent refusals together; four changed focused runs and all 35 required checks passed, exit 0.

- Task: AIC-5
- Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.
- Change: three real CLI refusals overlap, with every status and reason assertion retained. Readiness and later writes stay sequential. Eight CLI launches now take six turns instead of eight.
- Safety: done and finish open the seeded store and read before refusing; positive review refuses before opening it. No task mutation happens in these three paths. Store initialization may acquire a lock, handled by its existing busy retry. No production files or dependencies changed.
- Focused command: `node --test --test-name-pattern='^task proof-only agent env blocks acceptance verbs$' test/commands.test.js`
- Before wall milliseconds: [1245, 1205, 1206, 1208], four exit 0.
- After wall milliseconds: [989, 988, 1006, 1027], four exit 0.
- Metric: sequential samples averaged 1216ms before and 1003ms after, about 17.6% faster. This is a local sample, not a guarantee under load.

Focused output excerpt (last changed run):
```text
✔ task proof-only agent env blocks acceptance verbs (837.68925ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 966.338417
exit 0
```

Frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Frozen output excerpt:
```text
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 13571.324625
exit 0
```

Navigation and bookkeeping commands: atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json; atris task list --status open; atris task new; atris task claim AIC-5 --as auto-improver; atris task note AIC-5; git diff --check; atris task ready AIC-5; git add (declared files only); git commit; git push.

Activation reported missing generated brain files and plan-only exit 2. No broad generated policy changes were made. Existing edits in lib/task-db.js, test/landing-proof.test.js and atris/TODO.md were preserved and excluded from this commit.

The first ready attempt used bare node and failed in the task runner with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, exit 1. The interactive shell resolves node to `/opt/homebrew/bin/node`; ready was retried with that absolute executable, matching the successful direct test runs. The rerunnable ready command is `/opt/homebrew/bin/node --test --test-name-pattern='^task proof-only agent env blocks acceptance verbs$' test/commands.test.js`.

next_push: check whether the final accept and automatic-accept refusals in this same guard test can safely run together after the zero-reward review.
layer: capabilities
