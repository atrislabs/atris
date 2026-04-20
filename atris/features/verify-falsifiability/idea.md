# verify-falsifiability

> **Status:** complete
> **Created:** 2026-04-19
> **Last Updated:** 2026-04-19

## Problem statement

An agent could write `Verify: true` on any task and the tick would count as a success. The reward signal said "pass." The lessons log said "pass." Nothing actually ran. Silent rot of the whole RL loop, because the judge is what every future tick trusts.

## Solution design

Two locks, one thought. The task's `Verify:` field must point at a rubric, not be a raw shell string. Before any work happens, the rubric runs against the current tree. If it passes already, the rubric is trivial or the task is already done — halt, don't proceed. Only when the rubric actually fails at t=0 does the work begin. The same rubric (snapshotted) runs again after the work. That round-trip — fail before, pass after — is proof the task was real and the rubric is real.

```
task with Verify: "atris verify <slug> --section preflight"
        |
        v
  pre-execute: run rubric
        |
   +----+----+
   |         |
  pass     fail
   |         |
  halt    plan -> do -> review
  "not    -> run SAME snapshot
   falsifiable"         |
                   pass | fail
                        v
                     accept
                    the tick
```

## Success criteria

- [x] `atris verify <slug> --section <name>` extracts fenced bash under `## <name>` in `validate.md` and runs it
- [x] `runTaskOnce` runs Verify pre-execute for endgame + explicit-Verify tasks; halts on pre-pass
- [x] `atris.md` carries the constraint that Verify must be a falsifiable rubric, not a shortcut
- [x] 8 tests lock the gate in both directions (trivial halts, real proceeds)
- [x] This feature's own preflight runs the test suite, round-trips green

## User impact

The slop cannon and the editor collapse into the same person. The editor writes a rubric once (`validate.md`). The slop cannon generates against it. No more "I ran the tests, they passed" hand-waving — the rubric runs, the gate decides.

## Technical notes

- Gate runs only when `context.kind === 'endgame'` and `verifyResult.explicit` is true. Reactive ticks (inbox, staleness, imagined) keep their `npm test` default — they'd always pass at t=0 and break the loop.
- Verify cmd is captured once in `runTaskOnce` and reused after execute. An agent cannot swap rubrics mid-tick.
- Deferred: `[refactor]` tag for behavior-preserving changes where pre-verify can't fail by definition. Needs its own contract.
- Deferred: distinguishing `already-satisfied` (task done, no penalty, remove) from `verify-not-falsifiable` (trivial rubric, penalty). Both halt as `verify-not-falsifiable` for now; human reviews the lesson to disambiguate.
