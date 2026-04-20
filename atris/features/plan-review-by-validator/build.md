# plan-review-by-validator — Build Plan

> Executed 2026-04-19. Recorded retrospectively.

## Files touched

**Modified:**
- `commands/autopilot.js` — added `runPlanReview`, `buildPlanReviewPrompt`, `parseVerdict`, `appendPlanRejection`, `defaultPlanReviewExecutor`, `defaultCodexExecutor`, `hasCodex` helpers. Replaced the `['plan', 'do', 'review']` for-loop in `runTaskOnce` with explicit phase blocks and inserted plan-review between plan and do. Added `options.phaseExec` DI hook for testability. Imported `spawnSync`. Exported new functions.
- `atris/team/validator/MEMBER.md` — added the plan-review responsibility section with the strict SIGNOFF / REJECT+FIX output format.
- `atris/atris.md` — one line added to the `next` section documenting the plan-review phase.

**Created:**
- `test/autopilot-plan-review.test.js` — 9 tests covering SIGNOFF, REJECT, codex-absent-but-opted-in, codex-disagree, codex-agree, parse resilience (3 cases), and the `runTaskOnce` integration with stubbed phase executor.
- `atris/features/plan-review-by-validator/idea.md`, `build.md`, `validate.md` — this triptych.

## Build steps

1. **Plan double-check.** Sent M2 spec to the friend as second signer. Approved with three constraints: (a) depends on M1 (validator judges falsifiability); (b) machine-parseable output format; (c) codex is opt-in escalation, not universal blocker. One adjustment: REJECT journals but doesn't spam lessons.md.

2. **Validator spec first.** Added the plan-review section to `atris/team/validator/MEMBER.md` with the strict output format. This is the contract the validator must honor when spawned fresh.

3. **Extraction helpers.** Built `parseVerdict` (scans from end of output for the verdict line; tolerates preamble prose), `buildPlanReviewPrompt` (fresh-context prompt with atris.md / TODO.md / lessons.md as read-from-disk references), and the codex detection + executor functions.

4. **`runPlanReview` orchestrator.** Primary signer: validator. Opt-in gate for codex: `ATRIS_USE_CODEX=1` env var or tags `codex` / `gray` / `high-risk`. Absent-but-opted-in → skip with note. Both signers + disagreement → REJECT with both opinions surfaced as the reason.

5. **Wire into `runTaskOnce`.** Replaced the for-loop with explicit blocks: plan, plan-review (skippable via `options.skipPlanReview` for tests), do, review. On REJECT, halts immediately, journals, returns `outcome: 'halted', reason: 'plan-rejected-at-review'`.

6. **DI hook.** Added `options.phaseExec` so tests can replace `executePhaseDetailed` with a stub. Default falls through to the real claude-p path. One-line change; kept backward-compatible.

7. **Journaling.** `appendPlanRejection` computes the journal path from the passed `cwd` (not `process.cwd()`) so tests work in isolated tmp dirs. Writes a block under `## Notes` with task, signers, reason, fix, optional notes. Silent no-op if journal missing — never crashes the tick.

8. **Tests with fixtures.** 9 cases in isolated tmp dirs, each with `TODO.md`, `lessons.md`, and today's journal. Stub executors return canned strings. Total runtime 383ms.

## Testing strategy

`node --test test/autopilot-plan-review.test.js` — 9 tests, all green.

```
✔ SIGNOFF → verdict SIGNOFF with validator-only signer
✔ REJECT → verdict REJECT with reason and fix
✔ codex opted in but absent → skip gracefully with note
✔ codex disagreeing with validator → REJECT split verdict
✔ codex agrees with validator → SIGNOFF with both signers
✔ parseVerdict handles trailing verdict after preamble prose
✔ parseVerdict handles REJECT without FIX line as a soft pass-through
✔ parseVerdict treats garbage output as REJECT with parse-fail reason
✔ REJECT from plan-review halts runTaskOnce before do phase

9/9 pass — 383ms
```

Regression: M1's 8 tests still green. `options.phaseExec` is backward-compatible (default falls through to real claude-p).

## Error cases

- **Validator output missing verdict lines:** `parseVerdict` returns REJECT with a parse-fail reason, surfacing the model's failure to emit the required format.
- **Codex command missing but opted in:** `hasCodex` returns false, `runPlanReview` skips codex and attaches a note to the result.
- **Codex invocation throws:** caught, note attached, fallback to validator-only signoff.
- **Journal file missing:** `appendPlanRejection` silently no-ops. Journaling must never crash the tick.

## Dependencies

- Depends on **M1** (`verify-falsifiability`). The validator's plan-review checks that Verify is falsifiable, which requires M1's contract to be live.
- Uses `child_process.spawnSync` (new import) and the existing `execSync`.

## Rollback plan

`git revert <sha>` undoes everything. Test file is independent. Validator MEMBER.md change is additive — reverting only removes the plan-review section, the review section is untouched. No schema, no external state.

## Notes for future agents

- The validator's plan-review prompt deliberately does not include planning-phase context. Fresh read = independent signoff. Do not "optimize" this by passing through scratch from the planner.
- SIGNOFF reasons get captured in `phaseResults['plan-review'].output`. Good for audits.
- If you add a new phase (e.g., review-review for M2b), insert it as an explicit block, mirror the REJECT-halt pattern, use `options.phaseExec` for testability.
- `parseVerdict` scans from the end of the output. If you change the format, update both the validator MEMBER.md and the parser in the same commit.
