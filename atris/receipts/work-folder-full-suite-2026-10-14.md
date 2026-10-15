# All work folder and tidy checks pass together

Measured the broader folder cleanup tests in one real run: 95 checks passed, zero failed, zero skipped, exit 0. No runtime code changed. The run includes both frozen test files.

Flow: current checkout -> real Node test runner -> disposable Git fixtures -> saved output.

## Proof

Rerun: `node --test test/*worktree*.test.js test/*tidy*.test.js`

Actual output excerpt, exit 0:

```text
ℹ tests 95
ℹ suites 0
ℹ pass 95
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5912.793792
```

Full unfiltered output: `atris/receipts/work-folder-full-suite-2026-10-14.tap`.

Frozen command for a reviewer: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`. Both files were executed by the broader command above; no separate rerun was needed.

## Scope

Edited: this receipt, its TAP output artifact, and `atris/team/architect/logs/2026-10-14.md`. Preserved the pre-existing task view change.

Commands run: direct frozen check, completion-runner broader rerun, Atris boot, mission status and goal, task list/new/claim/note, git status/log/remotes, source and member context reads, the test command above, brain activation and compile previews, task ready, diff check, scoped commit and push. Brain previews exited 2 and wrote nothing; unavailable optional context files were reported without creating replacements.

Metric: 18 matching test files checked together, 95 passed, zero runtime changes. Passing tests establish current covered behavior, not protection for every possible deletion or lock shape.

## Files tested

- `test/fleet-stranded-worktrees.test.js`
- `test/member-tidy.test.js`
- `test/mission-worktree-baseline.test.js`
- `test/mission-worktree-receipt.test.js`
- `test/mission-worktree-start.test.js`
- `test/roster-runs-worktree.test.js`
- `test/task-worktree-state.test.js`
- `test/verify-worktree-rewrite.test.js`
- `test/worktree-cleanup-retention.test.js`
- `test/worktree-guard-conductor-artifacts.test.js`
- `test/worktree-removal-guard.test.js`
- `test/worktree-ship-denied-lane.test.js`
- `test/worktree-ship-detached.test.js`
- `test/worktree-ship-health.test.js`
- `test/worktree-ship-help.test.js`
- `test/worktree-start-base.test.js`
- `test/worktree-start-duplicate-guard.test.js`
- `test/worktree-start-retry.test.js`

next_push: reproduce why the completion runner fails 25 broader checks while the direct run passes, preserving full failure output before changing runtime code.

## Completion runner discrepancy

The direct broader command passed all 95 tests, but running that same command through task ready returned exit 1: 70 passed and 25 failed. The runner saved only a truncated excerpt, so the cause is not established. Its exact captured output is saved in `work-folder-full-suite-ready-2026-10-14.txt`. This is an unresolved environment discrepancy, not evidence of a runtime fix.

The direct frozen check then passed with exit 0: 27 passed, zero failed, zero skipped. Output: `work-folder-frozen-2026-10-14.tap`. A separate task-ready attempt was rejected before executing because its result sentence lacked the required operator benefit.

layer: environment

Completion status: proof-ready recording was rejected, so the task remains claimed with a handoff note rather than being marked reviewed or accepted. The proof artifacts were committed and pushed. Existing task-view edits were left untouched. Companion files also edited: work-folder-full-suite-ready-2026-10-14.txt and work-folder-frozen-2026-10-14.tap.

next_push: capture full completion-runner failure output and compare its environment to the direct invocation.

layer: environment
