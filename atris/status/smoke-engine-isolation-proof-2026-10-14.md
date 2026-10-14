# Quick command checks ignore the enclosing mission engine

The smoke check failed locally before the change: 1 passed, 1 failed, exit 1. ATRIS_RUNNER_PROFILE=codex selected codex as default, so the workspace engine list omitted the uninstalled house engine. The fixture now removes inherited selection before its explicit overrides. The existing test supplies codex in the parent environment and restores the original value, keeping the original assertion intact.

Files: test/smoke.fast.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, atris/TODO.md (generated task view), atris/status/smoke-engine-isolation-proof-2026-10-14.md, atris/status/for-you.md.

Verify: `node --test test/smoke.fast.test.js test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
Exit: 0. Full output: /tmp/auto-improver-tick11-proof-20261014.log

```text
✔ an engine benched at error routes again once the window passes, and with no stamp at once (47.95425ms)
ℹ tests 37
ℹ suites 0
ℹ pass 37
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10093.764667
```

Progress: one confirmed environment-dependent failure removed; 37 checks passed, zero failures, 10.094 seconds. No runtime code or test assertion was weakened.

Navigation and setup commands: atris mission status mission-2026-10-14-eliminate-flaky-tests-and-ti-ab805966; git status --short; atris task list --status open; atris; atris mission goal --json; atris task current; atris task new; atris task claim; atris task note. Brain activate/compile produced a plan only, with missing compiled inputs, so no unrelated generated policy was changed.

next_push: rerun test/one-lap-runtime.test.js in this checkout with unique saved output to confirm the inherited git-wrapper failure.
layer: capabilities

Review check: `/opt/homebrew/bin/node --test test/smoke.fast.test.js`, exit 0. The review shell resolved a different Node installation when given bare `node` and failed both smoke cases; the absolute runtime passed. Shared TODO rendering was restored to the pre-change version to preserve the backlog.
