# Team progress and checked results

The team supervisor now waits for a task with a runnable check, shows each working member's steps, and reports the checked result. The focused runtime tests and real team command passed.

## One bounded increment

Recovered the unfinished task-only guard from the previous timed-out attempt and completed its visibility and result reporting. No new mission or verifier changes. No dependencies added.

```text
open task + allowed check -> claim -> member work
                                -> live log -> name + time + step
                                -> checked task result -> done or failure
no checked task -> idle, no goal fallback
```

## Files edited

- commands/member.js: strict child claim path, compact checked JSON result, detached log handles, bounded final result read.
- lib/member-up.js: check requirement, idle output, live step formatting, exit drain, checked finish result, reader cleanup.
- lib/member-task-pick.js: opt-in requirement for a nonempty runnable check.
- lib/member-board.js: reuse existing line follower with optional time ordering within each scan.
- test/member-up.test.js: fake clock and spawner, temporary progress folders, two ordered streams, partial lines, actual watcher, finish result and false-success regressions.
- test/member-task-pick.test.js: missing and prose checks skipped in strict mode.
- test/member-go.test.js: real CLI refuses personal goal fallback and previews the valid task.
- test/member-verbs.test.js: existing supervisor fixtures now have runnable checks.
- atris/MAP.md and atris/refs/MAP-NOTES.md: updated routes and pointers.
- atris/proofs/member-up-strict-visible-2026-10-14.md: this receipt.
- atris/team/architect/logs/2026-10-14.md: appended lesson and next push, local member memory.

## Checks

Rerun:

```sh
node --test test/member-up.test.js test/member-task-pick.test.js test/member-verbs.test.js test/member-board.test.js test/member-go.test.js
```

Exit 0. Exact summary:

```text
ℹ tests 62
ℹ suites 0
ℹ pass 62
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4230.626042
```

Frozen verifier:

```sh
git diff --check
```

Exit 0, no output.

Real CLI invocation: `node bin/atris.js member wake 2`, from a temporary project with executor and navigator cards, standing mission text, an empty temporary task database, and a temporary progress directory. Sent SIGTERM after startup to stop the foreground supervisor. Output:

```text
executor is idle, no task with a check
navigator is idle, no task with a check
team is up (at most 2 at once). Ctrl-C to stop.
team is down
exit: 0

```

Assertions confirmed no child output folder and no mission file were created. The real CLI behavior is also covered by the rerunnable member-go test above. Live two-member work is proven with the real filesystem follower and a fake spawner, not a paid engine run.

## Progress

All four requested behaviors covered: no checked task stays idle, prose checks skipped, two prefixed step streams in timestamp order per scan, one finish result with the change summary or failure reason. 62 tests passed, none failed.

A missing worker summary falls back to its latest edit step, or explicitly says no change summary was reported. Events appended in later scans print when observed; the follower does not delay live output to reorder future events.

## Commands and artifacts

State inspected with `git status --short`, `atris`, `atris mission status mission-2026-10-14-make-atris-member-up-the-tea-bfb3cf29`, `atris mission goal --json`, and `atris task list`. Local task created and claimed as architect, with objective note and review proof. Brain activation and compile both returned plan-only, exit 2; no adapter or policy files rewritten.

Captured command outputs: /tmp/architect-member-up-cli-proof.txt and /tmp/architect-member-up-tests.txt. Durable proof and member memory paths are listed above.

next_push: show live steps for members that were already working when the supervisor started.
layer: capabilities
