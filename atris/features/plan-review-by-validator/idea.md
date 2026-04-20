# plan-review-by-validator

> **Status:** complete
> **Created:** 2026-04-19
> **Last Updated:** 2026-04-19

## Problem statement

After M1 made the Verify field falsifiable, there was still a gap: a plan could declare a valid Verify but fail to declare Files, Rollback, or dependencies correctly — and the agent would start working on a half-specified task. The contract needed a gate *before* execute, not just at the end.

## Solution design

Insert a `plan-review` phase between `plan` and `do`. Same validator that already runs `review` reads the plan fresh (no memory of planning context) and signs off with a machine-parseable verdict. If rejected, the tick halts and the rejection journals — the task stays in backlog, the planner revises.

Codex is optional second signer for high-risk tasks. Opt-in via `ATRIS_USE_CODEX=1` env var or tags `codex` / `gray` / `high-risk`. Absent but opted in → skip gracefully. Present and disagreeing → halt with both opinions surfaced.

```
plan (navigator)
    |
    v
plan-review (validator — fresh read)
    |
    +-- SIGNOFF: proceed to do
    |
    +-- REJECT: halt, journal rejection, task stays in backlog
    |
    [optional] codex second pass for gray/high-risk
```

## Success criteria

- [x] `runTaskOnce` sequences plan → plan-review → do → review
- [x] `runPlanReview` spawns a fresh validator pass via `claude -p` and parses SIGNOFF / REJECT
- [x] REJECT halts the tick; rejection appended to today's journal `## Notes`; lessons.md untouched
- [x] Codex is opt-in, not universal; absent + opted-in skips gracefully
- [x] Codex disagreement surfaces both opinions in the REJECT reason
- [x] `atris.md` documents the plan-review phase
- [x] Validator `MEMBER.md` names plan-review as a distinct responsibility with the machine-parseable output format
- [x] 9 tests lock SIGNOFF, REJECT, codex-absent, codex-disagree, parse resilience, and the runTaskOnce integration

## User impact

The validator becomes the taste-keeper at both gates — plan and review. Same role, same atris.md lens, same rubric. Plans that would have slipped through ("I'll figure out rollback later") now get caught before work starts. The exam-submission rhythm you named gains its first enforced half.

## Technical notes

- Output format is strict: `SIGNOFF: <reason>` or `REJECT: <reason>\nFIX: <fix>`. Parser scans from the end of the output so the verdict line can follow any amount of preamble prose.
- REJECT writes to journal `## Notes`, NOT lessons.md. Lessons are for reusable patterns; a rejection is just today's event unless a human promotes it.
- Codex invocation is spawned with a configurable command (`ATRIS_CODEX_CMD` env var, default `codex`). Tests stub via `options.codexExec`.
- `options.phaseExec` DI hook lets tests stub `claude -p` calls without real spawns — 9 tests run in 383ms.
- Deferred: M2b (review-review, same pattern applied to the post-execute verdict). Deferred: richer `tier`-based auto-codex triggering (today the signal is explicit opt-in, not risk-inferred).
