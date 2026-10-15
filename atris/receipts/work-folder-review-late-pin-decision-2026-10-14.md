# Review cleanup can delete a newly pinned folder

Decision: hold the production change for review under the mission's protected-surface rule. No cleanup implementation was edited or landed.

Evidence: `node atris/receipts/work-folder-review-late-pin-probe.js`, exit 0. In disposable real Git, a wrapper acquires a real pin only when removal starts. Git refuses with exit 128 and names the pin. The actual review disposal function ignores the refusal, returns `removed: true`, and recursively deletes the copy, its Git store, the quarantine store, and the review root. The diagnostic's exit 0 means the defect was reproduced, not that cleanup is safe.

Proposed bounded fix: capture the Git removal result in `lib/fleet.js:2502`. On any nonzero or missing status, return `removed: false` with the shared `describeRefusedRemoval` report before any recursive delete or removal log. Add a real-Git late-pin regression that asserts all stores, the pin, folder contents and registration survive, with no removal record. Retain the existing successful-disposal control. Review the isolated-store lifecycle before deciding whether any failed removal can safely fall through.

Plan: idle preflight -> real pin at removal -> Git refusal -> shared refusal report -> preserve every store.

The earlier source branch is present, but is not an ancestor of this checkout (`git merge-base --is-ancestor` returned 1). This diagnostic does not alter history or attempt to reconcile that earlier lineage.

next_push: review and implement fail-closed fleet disposal using the shared refusal report, with a real-Git late-pin regression.
