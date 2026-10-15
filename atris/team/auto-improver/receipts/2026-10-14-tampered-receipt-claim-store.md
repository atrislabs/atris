# Receipt tampering setup reduction

The receipt tampering test uses three CLI launches instead of four. The focused real CLI check and all 35 frozen checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Change: seed ownership with production taskStore.claimTask in the existing database connection, assert the claim, and close in finally. Real CLI ready, accept and tampered status remain, with all reward and integrity assertions unchanged.

Plan: inspect -> seed ownership -> focused real CLI check -> frozen checks -> review and push.

Commands and real output:
```text
node --test --test-name-pattern='^xp status fails closed when local receipt ledger is tampered$' test/commands.test.js
✔ xp status fails closed when local receipt ledger is tampered (536.769125ms)
tests 1; pass 1; fail 0; skipped 0; duration_ms 684.811417
exit 0

node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
tests 35; pass 35; fail 0; skipped 0; duration_ms 9947.9375
exit 0
```

Review proof rerun: the command runner resolved an older Node for bare `node`, failing with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, exit 1. Repeating through `/opt/homebrew/bin/node --test --test-name-pattern='^xp status fails closed when local receipt ledger is tampered$' test/commands.test.js` passed, exit 0, and moved the task to Review. Use this absolute Node path when rerunning through the Atris command runner.

Metric: one setup subprocess removed, four launches to three (25% fewer). No timing speedup claimed without a matched baseline.

Setup upkeep: brain activation and compilation both returned plan-only, exit 2, without changing generated policy files. Pre-existing local changes were preserved and excluded from this commit.

next_push: Remove the setup-only claim launch from the ready-work revision test, preserving both readiness commands, revision, stale acceptance and final state checks.
layer: capabilities
