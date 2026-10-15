Default runner checks now ignore inherited session settings; focused checks and folder-protection checks passed.

One bounded compatibility repair. Four default-command tests now use the existing withRunnerEnv helper, which clears and restores settings. Assertions and production behavior are unchanged. Two failures from the prior full run were reproduced with ATRIS_RUNNER_PROFILE=codex and disappeared when only that variable was unset.

Files edited: test/runner-command.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/briefs/work-folder-protection-tick-11.md. Task commands rendered atris/TODO.md from the local task database; its unrelated backlog replacement was excluded from the commit. Local ignored records appended: atris/team/architect/logs/2026-10-14.md; atris/status/for-you.md.

Changed-surface proof:
```sh
node --test test/runner-command.test.js
```
Before: exit 1, tests 40, pass 38, fail 2. A/B check: env -u ATRIS_RUNNER_PROFILE node --test test/runner-command.test.js, exit 0, tests 40, pass 40, fail 0.
After repair with original session settings: exit 0. Actual output excerpt:
```text
✔ buildRunnerCommand shell-quotes allowedTools in the default command shape (0.045542ms)
✔ buildRunnerCommand omits --allowedTools when not given (0.424458ms)
ℹ tests 40
ℹ pass 40
ℹ fail 0
```
Frozen check, rerun unchanged:
```sh
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
```
Exit 0. Actual output excerpt:
```text
✔ every work folder removal goes through the git check and the removal log (78.961625ms)
ℹ tests 19
ℹ pass 19
ℹ fail 0
ℹ duration_ms 3007.164375
```

Context commands: atris; atris mission status mission-2026-10-14-finish-work-folder-protectio-35ad161f; atris mission goal --json; atris task list --status open; atris task list --status working; git status --short; git log -3 --oneline; git branch --show-current. Read member identity, map, prior receipt and prior test output. Optional brain activation and compile each returned plan-only exit 2; absent generated files were not created. Task created, claimed and noted with declared scope; proof moved to Review without acceptance.

Progress: two previously failing assertions repaired; 40/40 focused tests and 19/19 frozen checks passed. The remaining nine prior failures were not rerun or declared fixed. No second slice and no full-suite claim.
next_push: isolate inherited Codex session markers in roster-selection tests after reproducing the two codex_goal mismatches.
layer: capabilities
