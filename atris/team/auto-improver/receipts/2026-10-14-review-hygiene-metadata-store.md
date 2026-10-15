# Review queue hygiene metadata setup reduction

The review cleanup test now starts five child processes instead of six (16.7% fewer). All five CLI calls and every behavior assertion remain; no elapsed-time improvement is claimed without a matched baseline.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-hygiene-metadata-store.md.

Plan: CLI create and review -> in-process metadata injection -> CLI queue and continuation refusal -> review and push.

Change: replace the separate Node SQLite process with the production task store. Preserve latest_agent_next_task exactly, retain the original absence of an updated_at write, and close in finally. No runtime code or dependencies changed.

Real command output:
```text
node --test --test-name-pattern='^task review hygiene reports generic continuation debt without mutation$' test/commands.test.js
✔ task review hygiene reports generic continuation debt without mutation (722.60375ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 862.789167
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 10899.105292
exit 0
```

Lesson: inject setup-only metadata in the same process, and retain the actual CLI reads that prove the persisted field changes behavior.

Upkeep: brain activation and compile both returned plan-only, exit 2. Existing notebook edits remain outside this commit. Task AIC-74 moves to Review without self-acceptance. Mission configuration is unchanged.

next_push: Remove the creation-only CLI launch from the review hygiene test using the real task store, retaining readiness, review, queue and continuation checks.
layer: capabilities
