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
