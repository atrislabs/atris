Reward rejection testing now starts the app twice instead of three times. The focused test and all 35 required health checks passed, exit 0.

Files edited: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and atris/team/auto-improver/receipts/2026-10-14-reward-rejection-readiness.md. Existing changes in lib/task-db.js, test/landing-proof.test.js, atris/TODO.md and the preceding log result are excluded from this commit.

Plan: production store creation -> claim -> ready -> close -> CLI reward refusal -> CLI show. Readiness is setup only; its output was not asserted. The original actor and proof are retained, with the standard fixture result. All rejection and pending-review assertions remain against the real CLI.

Proof commands and actual output:

```text
node --test --test-name-pattern='^task accept rejects non-positive rewards before marking done$' test/commands.test.js
Before: pass 1, fail 0, test 428.513875ms, duration_ms 570.478; exit 0.
After: pass 1, fail 0, test 305.707333ms, duration_ms 448.049709; exit 0.

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 15016.005958
exit 0
```

Proof registration first refused an unexecuted command claim, then its bare node invocation used an older runtime without node:sqlite (exit 1). Repeating registration with /opt/homebrew/Cellar/node/25.6.1/bin/node passed, exit 0, and moved the task to review. The original focused and frozen commands above used the supported runtime and both passed. No test or runtime policy was changed.

git diff --check: no output, exit 0.

Metric: one setup-only app launch removed, three become two. Single-run timings do not establish a stable speed gain.

Notebook activation and compile returned plan-only, exit 2; no generated policy files were written.

next_push: inspect setup-only readiness in the ready-work revision test while preserving revision and stale-proof CLI coverage.
layer: capabilities
