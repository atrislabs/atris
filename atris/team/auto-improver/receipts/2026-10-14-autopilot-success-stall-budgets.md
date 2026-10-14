# Successful review startup and deliberate stall use separate limits

The successful worker now has 30 seconds of startup headroom rather than one second. The intentional stall retains the real one-second deadline, with both recorded limits asserted and every prior assertion retained.

## Files
- test/roster-run-record.test.js
- atris/MAP.md
- atris/refs/MAP-NOTES.md
- atris/team/auto-improver/logs/2026-10-14.md (this entry only)
- this receipt

## Proof
Baseline: `node --test test/roster-run-record.test.js`, exit 0, 12 passed, 0 failed, duration_ms 27786.93475. The reported intermittent failure did not recur during baseline reproduction.

Required real-surface check: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0.

```text
✔ an autopilot phase on a roster worker records landed with tokens, or stalled at its cap (3104.511041ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 50309.692
```

`git diff --check`, exit 0. Independent reviewer confirmed fresh roster reads on each launch and preserved output, timeout and cap assertions. No production timeout changed, no dependencies added. The success limit adds headroom without adding sleep to successful runs.

Workspace startup commands: `atris`, `git status --short`, `atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c`, `atris mission goal --json`, and `atris task list --status open`. Task created, claimed and noted before edits. Brain activation and compilation reported plan-only, exit 2; no generated policy files were written.

next_push: Replace the setup-only claim in the duplicate receipt repair test with the real task store while retaining readiness, acceptance and repairing XP status CLI checks.
layer: capabilities
