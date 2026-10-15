# Review cleanup can delete a newly pinned folder

Decision: hold the production change for review under the mission's protected-surface rule. No cleanup implementation was edited or landed.

Evidence: `node atris/receipts/work-folder-review-late-pin-probe.js`, exit 0. In disposable real Git, a wrapper acquires a real pin only when removal starts. Git refuses with exit 128 and names the pin. The actual review disposal function ignores the refusal, returns `removed: true`, recursively deletes the copy, its Git store, the quarantine store, and the review root, then records a successful removal in the trusted project. The diagnostic's exit 0 means the defect was reproduced, not that cleanup is safe.

Proposed bounded fix: capture the Git removal result in `lib/fleet.js:2502`. On any nonzero or missing status, return `removed: false` with the shared `describeRefusedRemoval` report before any recursive delete or removal log. Add a real-Git late-pin regression that asserts all stores, the pin, folder contents and registration survive, with no removal record. Retain the existing successful-disposal control. Review the isolated-store lifecycle before deciding whether any failed removal can safely fall through.

Plan: idle preflight -> real pin at removal -> Git refusal -> shared refusal report -> preserve every store.

The earlier source branch is present, but is not an ancestor of this checkout (`git merge-base --is-ancestor` returned 1). This diagnostic does not alter history or attempt to reconcile that earlier lineage.

next_push: review and implement fail-closed fleet disposal using the shared refusal report, with a real-Git late-pin regression.

## Separate-store lifecycle proof

The strengthened probe uses the actual `prepareReviewSandbox` setup with a disposable local origin and tracked content, rather than substituting the trusted repository as the review store. It exercises two cases: idle removal succeeds with Git exit 0; a real pin taken only at removal makes Git exit 128. Both currently clear every review path and write one success record. The trusted project's content and commit, and the origin commit, remain unchanged in both cases. Exit 0 from this diagnostic means these observations were reproduced, not that cleanup is safe.

Pre-build verdict: proceed with a diagnostic only. The named failure mode is losing the separate review stores and falsely logging success after refusal. Before implementation, require the refused path to retain every store and registration, emit the shared refusal explanation, and write no removal record; retain the idle control to check intended disposal.

Plan: actual review setup -> idle control / late pin -> real Git result -> path and removal-record assertions.

## Refusal result and caller contract

Verdict: proceed with changes to the plan, pending the existing production review. The single failure mode is losing the refusal explanation at the caller: `describeRefusedRemoval` returns text, while the current caller reads only `describeGitHold(disposed) || disposed.pinned`.

At `lib/fleet.js:2502`, capture the removal result. For `status !== 0`, including null or missing status, return `{ removed: false, reason: 'removal_refused', detail }` before any recursive delete or success record. Set detail with `describeRefusedRemoval(boundary.worktreePath, result.stderr || result.stdout || result.error?.message || '')`. Add the shared helper to the existing import. Do not put this string in `pinned`, because generic refusal is not evidence of a pin.

At `lib/fleet.js:4006`, print `disposed.detail || describeGitHold(disposed) || disposed.pinned` so existing preflight results retain their explanations. Do not change import validation or the later handoff: cleanup refusal retains the source stores without undoing a verified import.

Plan: nonzero or missing removal status -> shared explanation -> retained stores and registration -> caller prints explanation -> no success record.

Required implementation proof: keep the idle real-Git control; turn the late-pin diagnostic into a retention regression; cover a refusal without a pin and a missing process status. Assert the returned detail and caller output contain the explanation without undefined text, every review store survives refusal, and no successful removal record is added. These checks are requirements for the next build, not claims of current coverage.

next_push: implement the two-site refusal contract after production review, retaining idle disposal and proving late-pin retention.


## Refusal without a pin

The disposable diagnostic now also moves the owned copy's `.git` link immediately before real Git removal. Preflight sees an intact copy; removal exits 128 with `validation failed` and no locked-folder explanation. Disposal still deletes all four review paths and writes one success record. The idle control and late-pin case remain, and all three retain trusted content and origin history.

Verdict: proceed with the existing fail-closed plan after production review. The single failure mode remains treating a refused removal as success. This case proves the safeguard must inspect the process result for every refusal, rather than retaining only pinned copies. A missing process status still needs separate proof.

next_push: prove missing removal status with a terminated disposable child before production implementation.
