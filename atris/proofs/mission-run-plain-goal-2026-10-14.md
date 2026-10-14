# Plain mission requests start local work

Plain shell requests now start the existing local worker instead of stopping after saving a goal. The frozen check passed, and a separate CLI run wrote and checked a real file using a controlled executable, without a model service.

## Files

- `commands/mission.js`: use the shared caller-aware default and continue local workers through the normal execution path.
- `test/mission-run-plain-goal.test.js`: real CLI regression for shell execution, native and manual/platform handoffs, and explicit local worker execution.
- `test/mission-plain-start.test.js`: explicitly declare the live Codex context tested by the handoff assertions.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: route and code locations.
- `atris/proofs/mission-run-plain-goal-live-2026-10-14.json`: exact CLI command, workspace, output excerpt, exit code, artifact text, and runtime receipt location.
- `atris/team/architect/logs/2026-10-14.md`: work and lesson.
- This receipt.

## Plan

plain shell request -> save goal -> existing local worker -> artifact -> frozen check -> proof

Proceed. The named risk is launching another worker inside an active Codex chat. Reuse the existing caller-aware default and retain native, manual, and platform goal handoffs.

## Verification

`node --test test/mission-run-plain-goal.test.js`

Exit 0. Exact summary output:

```text
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4152.837208
```

`node --test test/mission-run-default-runner.test.js test/mission-plain-start.test.js test/mission-budget-tier.test.js test/mission-auto-runner.test.js`: exit 0, 14 passed, 0 failed.

`node --test --test-name-pattern='mission run|mission objective shorthand|remote-computer mission run' test/mission-status.test.js`: exit 0, 48 passed, 0 failed.

`git diff --check`: exit 0, no output.

The separate command is recorded verbatim in the JSON proof. Output excerpt: `"action": "mission_run", "runner": "claude", "status": "complete", "ran_ticks": 1`. Exit 0. The check `test -s result.txt` exited 0, and the file contained `work completed` followed by a newline. This proves CLI dispatch and checking with a controlled worker, not model quality or live service availability.

Brain activation and compilation both returned plan previews. Their generated policy files were not written.

## Progress

One local request now executes one unit of work and checks its output. All four frozen cases pass, with 62 related checks passing. No follow-on code slice was started after the frozen check passed.

next_push: Show who is doing the work while a plain mission request is running.
layer: capabilities
