# Isolated command tests use fixture Git

Changed: test/one-lap-runtime.test.js removes enclosing mission Git wrappers from fixture PATH and prefers process.execPath's directory. The real Git lookup uses the same fixture PATH. No application code, sandbox policy, timeout, or assertion changed.

Before: a bare node under the inherited PATH resolved Node 20 and failed setup. With /opt/homebrew/bin/node, the existing main-branch case failed during build with node:internal/modules/cjs/loader:1228, exit 1, because the inherited Git wrapper loaded files outside the test sandbox. After: that exact case passed under the inherited PATH, exit 0, 13.486 seconds.

Focused verify: `/opt/homebrew/bin/node --test --test-name-pattern='a real isolated review on main' test/one-lap-runtime.test.js`
The after invocation also named the frozen files; the name filter did not execute their individual checks, so they were verified separately below.

Frozen verify: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

```text
✔ a real isolated review on main preserves the protected branch and imports the verified build (13485.922458ms)
ℹ fail 0
ℹ duration_ms 13589.470834

ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 10923.492916
```
Both commands exited 0. Progress: one confirmed environment-dependent command test failure removed; the frozen checks remain 35 passed, zero failed. This is focused proof, not a claim that the entire command file passed. A pre-change whole-file diagnostic was also launched with a login shell; it does not reproduce the inherited wrapper and is not acceptance proof. It stalled after its first four cases and was stopped, including its child processes, after focused proof passed; investigate its concurrent-ask case next.

Files: test/one-lap-runtime.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/status/one-lap-git-isolation-proof-2026-10-14.md; atris/status/for-you.md. Setup: git status --short; atris mission status; atris; atris task list/new/claim/note; atris mission goal --json. Brain activation/compile returned plan-only, exit 2; no generated doctrine was changed. Task setup rewrote the shared rendered backlog, which was restored from HEAD.

next_push: run the complete isolated command test file with the original mission PATH and supported Node runtime, then repair one confirmed remaining failure.
layer: capabilities
