# landing

Landing a task: ready with proof, receipts, accept and accept-group, certify-verified, auto-accept and the sweep.

Owner: `orb` (atris/team/orb/MEMBER.md)

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [projection](../projection/README.md), [review-evidence](../review-evidence/README.md), [board](../board/README.md), [reviews](../reviews/README.md), [core](../core/README.md), [card](../card/README.md), [results](../results/README.md), [todo-sync](../todo-sync/README.md), `commands/task.js` itself.

## Files

### landing.js

Functions (35): `stampAcceptGroupMetadata`, `cmdAcceptGroup`, `readyWorkRoot`, `cmdReady`, `cmdTaskReceipt`, `cmdAccept`, `landingProofVerify`, `stampAutoAcceptMetadata`, `acceptReviewTask`, `certifyVerifyCandidate`, `verifyIsOnlyFileChecks`, `stampCertifyVerifyMetadata`, `currentHeadSha`, `stampVerifyCacheMetadata`, `lastCheckedMs`, `failedOnSameCode`, `stampReadyVerifyMetadata`, `landingVerifyFailureNote`, `reverifyBeforeLanding`, `createRunBudget`, `acceptOrder`, `markAcceptDeferred`, `cmdCertifyVerified`, `cmdLanding`, `cmdAutoAcceptCertified`, `autoAcceptSweepLabelValues`, `autoAcceptSweepNormalizedTokens`, `autoAcceptSweepLane`, `autoAcceptSweepDeniedReason`, `autoAcceptSweepLatestProof`, `autoAcceptSweepVerifierEvidence`, `autoAcceptSweepHappened`, `evaluateSweepAutoAccept`, `cmdSweepHeld`, `cmdSweep`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
