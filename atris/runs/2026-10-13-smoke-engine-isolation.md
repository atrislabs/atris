# Smoke test engine isolation, 2026-10-13

The fast smoke test now supplies its own engine installation and selection. The real CLI passed all assertions in four runs after the change, including three different inherited engine selections.

## Scope and cause

Only one test file changed: test/smoke.fast.test.js. Workspace engine lists contain installed or selected engines. The fixture omitted ax and inherited ATRIS_RUNNER_PROFILE from the mission runner, so atris-fast could be absent. Supply a disposable ax and explicitly select atris-fast for that command. Keep the existing inclusion assertion; add workspace scope, default selection, and installed-state assertions. No production files, dependencies, mission settings, or other tests changed.

Plan: baseline failure -> isolated engine fixture -> repeated real CLI runs -> review -> commit and push.

## Before

Prior timing artifacts: /tmp/ai-timing/run1.txt and /tmp/ai-timing/smoke-{1,2,3,4,5}.log. Five prior reruns failed, each with pass 1 / fail 1. Two fresh bare invocations of node --test test/smoke.fast.test.js exited 1 with the original engine-presence assertion failing, duration_ms 712.811750 and 442.239208.

## After

First bare invocation: node --test test/smoke.fast.test.js, exit 0, pass 2 / fail 0, duration_ms 427.151334.

Command: ATRIS_RUNNER_PROFILE=codex node --test test/smoke.fast.test.js
Exit: 0
✔ real atris binary fast smoke covers core read-only commands (241.367125ms)
✔ real atris binary fast smoke covers wish questions and task render temp paths (158.530125ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 438.260625

Command: ATRIS_RUNNER_PROFILE=claude node --test test/smoke.fast.test.js
Exit: 0
✔ real atris binary fast smoke covers core read-only commands (242.748667ms)
✔ real atris binary fast smoke covers wish questions and task render temp paths (157.860542ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 431.429542

Command: ATRIS_RUNNER_PROFILE=grok node --test test/smoke.fast.test.js
Exit: 0
✔ real atris binary fast smoke covers core read-only commands (240.060625ms)
✔ real atris binary fast smoke covers wish questions and task render temp paths (162.620541ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 432.792209


## Verification and landing

Rerunnable command: node --test test/smoke.fast.test.js
Frozen check: git diff --check, exit 0, no output.
Changed artifacts: test/smoke.fast.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-13.md; this receipt; atris/status/for-you.md.
Task: AIT-1, ready for review, never self-accepted. The rendered TODO refresh from local task creation is excluded because this checkout's local task database does not contain the launcher's full backlog.
Mission attachment was unavailable because the live parent owns the mission lock; mission fields were not modified. Brain activation returned plan-only exit 2 with missing generated files; compilation is also plan-only to avoid unrelated policy edits.

Metric: failing file changed from 0/7 passing baseline runs to 4/4 passing fixed runs. No speedup claim, this repairs an environment-dependent failure.
next_push: time test/mcp.test.js three times and replace one fixed asynchronous delay with an explicit completion signal while retaining real-process protocol checks.
layer: capabilities
