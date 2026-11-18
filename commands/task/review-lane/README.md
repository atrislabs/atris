# review-lane

The review lane: drain, act, loop and run, which work through tasks waiting for review.

Owner: `validator` (atris/team/validator/MEMBER.md)

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [projection](../projection/README.md), [review-evidence](../review-evidence/README.md), [next](../next/README.md), [capabilities](../capabilities/README.md), [card](../card/README.md), [reviews](../reviews/README.md), `commands/task.js` itself.

## Files

### review-lane.js

Functions (30): `taskReviewLaneDrainTask`, `humanAcceptWaitingDrain`, `proofBoundaryBlockedDrain`, `pendingReviewChatDrain`, `taskReviewLaneDrainSelection`, `taskReviewLaneDrainReport`, `cmdReviewLaneDrain`, `taskReviewLaneActOptionsFromArgs`, `taskReviewLaneActOptionsFromBody`, `autoReviewableEvidence`, `autoReviewPendingReviewTask`, `taskReviewLaneAct`, `cmdReviewLaneAct`, `normalizeReviewLaneLoopMaxSteps`, `taskReviewLaneLoopStopIsSafe`, `taskReviewLaneActSelectionKey`, `taskReviewLaneLoopOptionsFromArgs`, `taskReviewLaneLoopOptionsFromBody`, `compactReviewLaneLoopStep`, `taskReviewLaneLoop`, `cmdReviewLaneLoop`, `normalizeReviewLaneRunMaxRuns`, `taskReviewLaneRunOptionsFromArgs`, `taskReviewLaneRunOptionsFromBody`, `taskReviewLaneRunStopIsSafe`, `reviewLaneRunReceiptPaths`, `compactReviewLaneRunLoop`, `writeReviewLaneRunReceipt`, `taskReviewLaneRun`, `cmdReviewLaneRun`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
