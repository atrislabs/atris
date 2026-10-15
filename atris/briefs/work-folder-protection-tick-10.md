Folder-protection compatibility proof saved: the frozen check passed; the full suite failed.

This increment ran checks on the already merged release without editing code. The full run completed instead of timing out, so the next pass has concrete failures to investigate.

Files edited: atris/briefs/work-folder-protection-tick-10.md; atris/team/architect/logs/2026-10-14.md (local, ignored).
Artifacts: /tmp/architect-folder-protection-tick-10-full-tests.log; this receipt.

Commands run for context: git status --short; atris mission status mission-2026-10-14-finish-work-folder-protectio-35ad161f; atris; atris brain activate --root . --verify; atris mission goal --json; atris task list --status open; atris task list --status working; atris mission attach-task 18 --json.
The task attachment was refused because the running mission owns its lock. No lock or mission configuration was changed. Brain activation returned a plan only; optional compiled context files were absent.

Rerunnable verify command:
```sh
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
```
Exit: 0. Actual output excerpt:
```text
✔ every work folder removal goes through the git check and the removal log (168.524625ms)
✔ green landing keeps its scratch folder while a test is still running in it (258.455708ms)
✔ green landing names who removed its scratch folder and why (215.95225ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7613.606041
```

Broad check command (no pipe, shell preserves test exit status):
```sh
node --test > /tmp/architect-folder-protection-tick-10-full-tests.log 2>&1
```
Exit: 1. Actual output summary:
```text
ℹ tests 5750
ℹ suites 22
ℹ pass 5739
ℹ fail 11
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 504814.66575
```

Failing test locations from the actual output:
```text
test at test/lesson-gate.test.js:113:3
test at test/lesson-gate.test.js:150:3
test at test/lesson-gate.test.js:180:3
test at test/member-run-start.test.js:226:1
test at test/mission-run-reliability.test.js:156:1
test at test/mission-run-reliability.test.js:211:1
test at test/roster-markdown.test.js:486:1
test at test/roster-markdown.test.js:540:1
test at test/runner-command.test.js:342:1
test at test/runner-command.test.js:388:1
test at test/smoke.fast.test.js:52:1
```

Observed failures include expected auto/claude runners being replaced by codex_goal, an absent atris-fast engine, mission subprocess startup, and lesson candidate filtering. This run does not establish whether those are inherited environment effects or defects. No claim of a green full suite or unrelated fixes is made.

Progress: frozen check 19/19 passed; full suite completed in 504.8 seconds, 5739/5750 passed, 11 failed. No new code removals or exceptions introduced. This proof record is safe to push; removal behavior is unchanged.
next_push: reproduce the runner-selection failures with inherited runner overrides cleared in the test subprocess, then add explicit test isolation if that proves the cause.
layer: capabilities
