# Keep test settings until asynchronous work finishes

The isolation plan now includes a demonstrated timing safeguard. The real
command builder changed from Claude before an await to inherited Codex after
it when called through the existing test helper; the reproduction exited 0.

## Verdict

Proceed-with-changes on the earlier engine-test isolation plan. The single
failure mode is restoring the parent engine settings before an asynchronous
test callback finishes. The current `withRunnerEnv` helper calls `fn()` without
returning or awaiting its promise, then restores settings immediately.

Keep that helper for synchronous tests only. For the asynchronous lesson tests,
use paired setup and teardown hooks, or a separate asynchronous helper that
returns and awaits the callback promise inside its try/finally. Require a
regression that builds a command after an await and another that rejects after
an await, checking that all seven settings are restored on both paths. Preserve
the earlier requirement to fail before executing an unexpected model command.

This is a safeguard for the proposed repair, not a claim that the current
lesson tests use this helper. No runtime or test implementation changed.
Hand back to the implementation owner; this advice does not approve a merge.

```text
parent settings -> test settings -> await -> test settings -> restore parent
                                  reject -----------------> restore parent
```

## Real-surface proof

Run `node atris/receipts/async-runner-isolation-proof.cjs`, exit 0:

```text
before await: claude command
after await: inherited codex command
helper returned no promise; no model command executed
```

The script reads the existing helper from the actual test file, runs it in a
VM context, and calls the actual exported command builder on both sides of an
await. It executes no generated shell command and restores its own environment.
It asserts the current defect; it is an advisory reproduction, not a passing
acceptance test for the future repair. Once the helper is repaired, retire or
update this reproduction.

## Scope and progress

Edited this receipt, `atris/receipts/async-runner-isolation-proof.cjs`,
`atris/team/architect/logs/2026-10-14.md`, `atris/MAP.md`, and
`atris/refs/MAP-NOTES.md`. Task commands also regenerate `atris/TODO.md`;
unrelated queue replacement is excluded. The supplied task is absent locally,
so a local advisory task was created and claimed. No mission setting, tool
policy, member instruction, or dependency changed.

Progress: one additional repair safeguard backed by two real command-builder
observations. Rollback: revert this documentation and reproduction change.

next_push: repair engine-test isolation with asynchronous restoration and a guard against unexpected model execution.

layer: beliefs

## Frozen verification and stop reason

Ran once: `npm run test:fast > /tmp/architect-async-isolation-test-fast.log 2>&1`.
Exit 1, with no pipeline or engine overrides.

```text
ℹ tests 1882
ℹ suites 22
ℹ pass 1877
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 111910.62925
```

Three lesson cases launched inherited Codex and returned `Not inside a trusted
directory and --skip-git-repo-check was not specified.` Two default command
cases expected Claude flags but received `codex exec "$(cat /tmp/p.tmp)"`.
The frozen check remains unchanged. Stop: this advisory increment is saved,
but the failed check prevents proof-ready or mission completion. Repair belongs
to the implementation owner, outside the architect's advisory scope.

Brain activation returned exit 2 with a plan-only message; compilation also
printed its write plan. Neither generated files nor policy were changed.
`git diff --check` exited 0 with no output. The review and safe reproduction
are committed and pushed for handoff, not merged or accepted.

next_push: repair engine-test isolation with asynchronous restoration and a guard against unexpected model execution.

layer: beliefs
