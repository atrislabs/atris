# Review cleanup can delete a newly pinned folder

Decision: hold the production change for review under the mission's protected-surface rule. No cleanup implementation was edited or landed.

Evidence: `node atris/receipts/work-folder-review-late-pin-probe.js`, exit 0. In disposable real Git, a wrapper acquires a real pin only when removal starts. Git refuses with exit 128 and names the pin. The actual review disposal function ignores the refusal, returns `removed: true`, recursively deletes the copy, its Git store, the quarantine store, and the review root, then records a successful removal in the trusted project. The diagnostic's exit 0 means the defect was reproduced, not that cleanup is safe.

Proposed bounded fix: capture the Git removal result in `lib/fleet.js:2502`. On any nonzero or missing status, return `removed: false` with the shared `describeRemovalResult` report before any recursive delete or removal log. Add a real-Git late-pin regression that asserts all stores, the pin, folder contents and registration survive, with no removal record. Retain the existing successful-disposal control. Review the isolated-store lifecycle before deciding whether any failed removal can safely fall through.

Plan: idle preflight -> real pin at removal -> Git refusal -> shared refusal report -> preserve every store.

The earlier source branch is present, but is not an ancestor of this checkout (`git merge-base --is-ancestor` returned 1). This diagnostic does not alter history or attempt to reconcile that earlier lineage.

next_push: review and implement fail-closed fleet disposal using the shared refusal report, with a real-Git late-pin regression.

## Separate-store lifecycle proof

The strengthened probe uses the actual `prepareReviewSandbox` setup with a disposable local origin and tracked content, rather than substituting the trusted repository as the review store. It exercises two cases: idle removal succeeds with Git exit 0; a real pin taken only at removal makes Git exit 128. Both currently clear every review path and write one success record. The trusted project's content and commit, and the origin commit, remain unchanged in both cases. Exit 0 from this diagnostic means these observations were reproduced, not that cleanup is safe.

Pre-build verdict: proceed with a diagnostic only. The named failure mode is losing the separate review stores and falsely logging success after refusal. Before implementation, require the refused path to retain every store and registration, emit the shared refusal explanation, and write no removal record; retain the idle control to check intended disposal.

Plan: actual review setup -> idle control / late pin -> real Git result -> path and removal-record assertions.

## Refusal result and caller contract

Verdict: proceed with changes to the plan, pending the existing production review. The single failure mode is losing the refusal explanation at the caller: `describeRefusedRemoval` returns text, while the current caller reads only `describeGitHold(disposed) || disposed.pinned`.

At `lib/fleet.js:2502`, capture the removal result. For `status !== 0`, including null or missing status, return `{ removed: false, reason: 'removal_refused', detail }` before any recursive delete or success record. Set detail with `describeRemovalResult(boundary.worktreePath, result)`. Add the shared helper to the existing import. Do not put this string in `pinned`, because generic refusal is not evidence of a pin.

At `lib/fleet.js:4006`, print `disposed.detail || describeGitHold(disposed) || disposed.pinned` so existing preflight results retain their explanations. Do not change import validation or the later handoff: cleanup refusal retains the source stores without undoing a verified import.

Plan: nonzero or missing removal status -> shared explanation -> retained stores and registration -> caller prints explanation -> no success record.

Required implementation proof: keep the idle real-Git control; turn the late-pin diagnostic into a retention regression; cover a refusal without a pin and a missing process status. Assert the returned detail and caller output contain the explanation without undefined text, every review store survives refusal, and no successful removal record is added. These checks are requirements for the next build, not claims of current coverage.

next_push: implement the two-site refusal contract after production review, retaining idle disposal and proving late-pin retention.


## Refusal without a pin

The disposable diagnostic now also moves the owned copy's `.git` link immediately before real Git removal. Preflight sees an intact copy; removal exits 128 with `validation failed` and no locked-folder explanation. Disposal still deletes all four review paths and writes one success record. The idle control and late-pin case remain, and all three retain trusted content and origin history.

Verdict: proceed with the existing fail-closed plan after production review. The single failure mode remains treating a refused removal as success. This case proves the safeguard must inspect the process result for every refusal, rather than retaining only pinned copies. A missing process status still needs separate proof.

next_push: prove missing removal status with a terminated disposable child before production implementation.

## Interrupted removal proof

The fourth disposable case terminates a real Node child with SIGTERM, asserts its actual process result has null status and SIGTERM, then propagates that signal through the Git wrapper at removal. The actual disposal function still returns removed true, deletes all four review paths and records success. The trusted content and both saved commits remain unchanged. This is process-boundary fault injection, not a claim that Git itself crashed.

Verdict: proceed with the existing plan after production review. The single failure mode is treating an interrupted removal as success. Require status exactly zero before deleting any store; truthiness or a positive-status test would miss null. Preserve all stores and registration on interruption, return a useful detail even without stderr, and write no success record.

Plan: real child terminates -> wrapper propagates signal -> null removal status -> retain all stores in the proposed fix.

next_push: add signal and process-error fallback wording to the refusal contract before production review.

## Fallback wording when Git leaves no text

Verdict: proceed with changes to the refusal contract, pending the existing production review. The single failure mode is a refusal report that hides why removal stopped. Fed only empty output, the shared helper says `git would not remove it` for a removal ended by a signal, so the reader cannot tell an interrupted run from a real Git refusal.

Use the existing whole-result reader, `describeRemovalResult(boundary.worktreePath, result)`, imported from `commands/worktree.js:1403`. Do not duplicate its fallback selection in fleet. The shared reader handles timeout before partial output; otherwise it uses Git text, a launch error, a signal, then missing status. It passes the chosen words through `describeRefusedRemoval`, preserving pin and hold precedence.

The status gate stays `result.status !== 0`, before every raw delete and success record. The caller prints `disposed.detail || describeGitHold(disposed) || disposed.pinned`. A refusal must not undo the verified import or claim successful disposal.

Earlier evidence: a real terminated child returns null status, SIGTERM, and empty output; the current rule prints the vague line and the proposed rule names the signal. A real launch of a missing binary returns null status and ENOENT; both rules name it, and the proposed one says Git could not run. Proof: `atris/receipts/work-folder-review-fallback-wording-2026-10-14.txt`.

Plan: process result -> Git text or fallback -> shared helper -> pin or hold first -> one plain line.

next_push: implement the two-site refusal contract with this fallback after production review, and assert the signal wording in the interrupted regression.


## Shared reader recheck

Verdict: proceed with the two-site plan after the existing protected-surface review. The single risk is duplicating fallback logic and losing the timeout explanation when partial output exists. The concrete safeguard is passing the whole result to the existing shared reader and retaining every store unless status is exactly zero.

Plan: removal result -> exactly-zero gate -> shared reader on refusal -> caller prints detail -> no raw delete or success record.

`node atris/receipts/work-folder-review-result-probe.js` invokes real interrupted, failed-launch and timed-out children through the shared reader. The timeout child writes partial output first; the report still names the timeout. A separately labeled synthetic missing-metadata case checks the final fallback. This proves the proposed reporting dependency only, not fleet retention or caller output. Production disposal still needs the retention and output regressions above before landing.

next_push: implement the two-site refusal gate after protected review, using the whole-result reader and converting the existing disposal diagnostic to retention assertions.

## Pending regression and fixture risk

Verdict: proceed with the two-site plan after protected review, with one change. The single failure mode is the idle-removal fixture: `reviewSandbox()` in `test/worktree-removal-guard.test.js` points at a git store that does not exist, so git's removal always exits 128 there. The test that checks who removed a review copy passes today only because that result is ignored. A trial of the exactly-zero gate, reverted before commit, failed that test and passed every other required check. The builder must give that fixture a real review store in the same change, so the idle control keeps proving intended disposal instead of being rewritten to expect a refusal.

The late-pin retention regression is now in the required suite as a todo test, written to this contract: `{ removed: false, reason: 'removal_refused', detail }`, every store kept, the pin unchanged, and no removal record. Today it reproduces the deleted copy (`removed: true`). Drop the todo when the fleet change lands.

A pin-only gate was tried and rejected: it puts generic refusal text in the pin field and still deletes copies git refused for other reasons.

Proof: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0, 57 passed, zero failed, one todo.

next_push: after protected review, land the exactly-zero gate and caller detail line, give the review fixture a real store, and drop the todo.

## Landed

The two-site refusal contract above landed in fleet review cleanup. The three pending checks in `test/worktree-removal-guard.test.js` now run as real passes, and this probe now asserts the kept result: idle removal still clears every store with one record, while a late pin, a missing link, or a stopped removal keeps every store, records nothing, and names git's reason. Proof: `atris/receipts/work-folder-review-pending-cleared-2026-10-14.txt`.
