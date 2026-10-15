Forced mission runners now retain the kill signal and cause; node --test test/engine-resource.test.js test/engine-dispatch.test.js passed, 92 pass, 0 fail, exit 0.

Files: commands/mission.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, atris/receipts/mission-force-kill-resources-2026-10-14.md.

Failing first: node --test --test-name-pattern='mission runners record paired' test/engine-resource.test.js, exit 1. Actual signal undefined, expected SIGKILL on the codex shell path. The shell reported its killed child as exit 137.

Rerun: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Output: tests 92; pass 92; fail 0; exit 0. Runtime: Node v25.6.1.
Real changed surface: the regression invokes the actual CLI in temporary projects, with local executable runners that kill themselves using kill -9 $$, without paid model calls. Commands: node bin/atris.js mission start <fixture objective> --owner mission-lead --runner <codex|claude> --no-verify --json; node bin/atris.js mission run <fixture mission> --max-ticks 1 --max-wall 60 --no-verify --json. Full JSON uses the test helper's environment setting.
Output excerpts:
codex force-kill CLI exit 0: end, SIGKILL, cause killed (cause unknown), free_pct 79, load [3.62,4.2,5.15], duration_ms 19.
claude force-kill CLI exit 0: end, SIGKILL, cause killed (cause unknown), free_pct 79, load [3.62,4.2,5.15], duration_ms 5.
CLI exit 0 describes successful command handling; the enclosed engine result is a failure. Each killed run retained exactly one start and one end sharing its run id. Successful paths also remain covered.

git diff --check: no output, exit 0.
Scope: one signal normalization and two real forced-stop scenarios added to the existing regression. No dependencies or mission settings changed. Exit 137 follows the dispatch path's existing convention; a program deliberately exiting 137 is indistinguishable from the shell reporting a killed child.
Task proof reached Review using /opt/homebrew/bin/node --test test/engine-resource.test.js test/engine-dispatch.test.js, exit 0; receipt atris/runs/2026-10-14-task-efm-7-2026-10-14T15-02-14-190Z.json. The mission check is unchanged. Acceptance remains pending because automatic certification cannot rerun the absolute runtime path.

Independent review: approved, no blocking defect; focused CLI regression passed, exit 0.
Brain activation and compile returned plan-only; no generated doctrine was overwritten. Existing rendered task and member-log changes were preserved.

Progress: two forced-stop runtime scenarios covered; one missing kill-cause path repaired.
next_push: prove final resource recording after mission runner spawn errors and time-limit escalation.
layer: capabilities
