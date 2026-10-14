# Plain goals execute work

A plain shell goal now starts work and runs its check in the same command. The frozen behavior check and a direct run with the installed Claude worker both passed.

## Change

The new-objective path uses the existing caller-aware runner selection, then enters the existing locked execution loop for executable runners. Live Codex and explicitly chosen caller-session goals retain their native goal handoff. The native-goal smoke check now explicitly selects its runner. Older tests explicitly identify their native-goal context; the budget test selects a native goal when testing planning metadata.

Plan: goal -> save -> existing worker loop -> artifact -> frozen check -> saved proof.
Risk and safeguard: starting a nested worker inside live Codex could duplicate work; native-goal tests prove those callers still only receive the handoff.

## Files edited and artifacts

- `commands/mission.js`
- `test/mission-run-plain-goal.test.js`
- `test/mission-plain-start.test.js`
- `test/mission-budget-tier.test.js`
- `test/mission-status.test.js`
- `atris/MAP.md`
- `atris/refs/MAP-NOTES.md`
- `atris/team/architect/logs/2026-10-14.md`
- `atris/runs/plain-goal-proof-2026-10-14.json`
- `atris/runs/plain-goal-tick-2026-10-14.md`
- `atris/runs/2026-10-14-task-aap-1-2026-10-14T12-18-35-948Z.json` (generated task-check receipt)

## Repeatable verification

`node --test test/mission-run-plain-goal.test.js`

Exit: 0. Exact summary output:

```text
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`node --test test/mission-run-plain-goal.test.js test/mission-plain-start.test.js test/mission-run-default-runner.test.js test/mission-budget-tier.test.js`

Exit: 0. Exact summary output: `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`.

`node --test --test-name-pattern='mission run (preflights|with an objective|with atris2|.*starts)' test/mission-status.test.js`

Exit: 0. Exact summary output: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

`git diff --check`: exit 0, no output.

## Direct runtime proof

The installed Claude worker ran against a separate temporary workspace, without the executable fixture used by the behavior tests. The saved JSON contains the complete stdout, stderr, exact command, working directory and deliverable text.

Environment: `ATRIS_CALLER_RUNTIME=terminal`, inherited runner overrides removed.

Command (run in the working directory recorded in the JSON):

```sh
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-a-plain-mission-run-with-a-goal-actu-20261014-121011/bin/atris.js mission run "write result.txt containing plain goal proof and stop after checking it" --verify "test -s result.txt" --max-ticks 1 --max-wall 60 --json
```

Exit: 0. Exact stdout excerpt:

```json
"action": "mission_run"
"ran_ticks": 1
"verifier_passed": true
```

Final state: ready. Deliverable: `result.txt`, nonempty and checked. Full evidence: `atris/runs/plain-goal-proof-2026-10-14.json`.

Task proof-ready gate: `node bin/atris.js task ready AAP-1 --verify "node --test test/mission-run-plain-goal.test.js"` (with the saved proof and plain result), exit 0. It independently reran the frozen command and saved `atris/runs/2026-10-14-task-aap-1-2026-10-14T12-18-35-948Z.json`; local task is in Review.

## Progress and next move

One invocation now creates one checked deliverable instead of returning only a plan. Nineteen targeted checks passed, including the four frozen checks. No human question was needed to build or prove this slice; task acceptance remains separate.

Brain activation and compilation both reported a plan only, so generated agent-policy files were not rewritten. Local task state was initialized because the copied checkout had no task records; the parent driver owns the current mission lock, which was left intact.

next_push: make plain goal runs return a failing exit code when the worker or completion check fails.
layer: capabilities
