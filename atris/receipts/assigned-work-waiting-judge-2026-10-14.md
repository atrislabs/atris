# Judge verdict: explain why assigned work is waiting

## Verdict

Proceed, scoped to jobs assigned to the member asking. Build it as a
combination of parts that already exist, so it needs no operator gate.

The plan under review is the next push from the assignment fix: when a named
member cannot take its assigned job because the job needs a runnable check,
say so in plain words instead of the generic "no task with a check".

## What changed since the architect's review

The architect reviewed this plan on a branch that never reached master. Its one
risk was blaming the idle member for someone else's job: the picker tested for a
missing check before it tested the job type.

On master today, assignment is checked first (`lib/member-task-pick.js:83`). For
a job assigned to the asking member, the picker never reaches the job type test,
so its reason is true. The risk survives only for unassigned jobs.

Real run on this checkout, `node -e` against `skipReason`, exit 0:

```text
unassigned build, no check, asked by review member   -> no_check
assigned to architect, no check                      -> no_check
assigned to architect, prose check                   -> check_not_runnable
assigned to executor, no check                       -> other_member
```

Row one is the surviving false reason. Rows two and three are the truthful
reasons the plan wants to show. Row four shows other members' jobs are already
filtered out before any check test.

## Combination

`saved assignee` + `existing skip reason` + `idle reply` -> plain waiting reason.

All three parts ship with tests: `test/task-owner-pick.test.js`,
`test/member-task-pick.test.js`, and the idle reply at `commands/member.js:10735`.

## Build rules

One. Only explain open, unclaimed jobs whose saved assignee is this member.
Never explain unassigned jobs, which is where the false reason lives.

Two. Reuse `skipReason` as is. Map `no_check` to "has no check to run" and
`check_not_runnable` to "its check is written as words, not a command". Show
`needs_human` and `protected_lane` as waiting on a person.

Three. Read only. The explanation must not claim, release, or edit any row, and
a store read failure stays a failure, never a waiting reason.

Four. Keep the idle exit code and the `reason` field unchanged so callers that
parse them keep working. Add the explanation as a new field.

Five. Regression through the real CLI with two members in a temp project: one
assigned job with no check, one with a prose check, one unassigned build job
with no check. The asking member sees the two assigned reasons and nothing
about the unassigned job, and every row stays open.

## Stop

Review only. No runtime code changed. The build is the next increment.

next_push: Add a read-only "waiting" list to the idle reply of `member go --needs-check`, covering only jobs assigned to that member, with the five rules above.

layer: beliefs
