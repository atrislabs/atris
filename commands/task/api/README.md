# api

The local task API server behind atris task serve: its routes, reads and writes.

Owner: unassigned

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [projection](../projection/README.md), [review-evidence](../review-evidence/README.md), [next](../next/README.md), [capabilities](../capabilities/README.md), [review-lane](../review-lane/README.md), [core](../core/README.md), [card](../card/README.md), [plans](../plans/README.md), [results](../results/README.md), [reviews](../reviews/README.md), [steps](../steps/README.md), `commands/task.js` itself.

## Files

### api.js

Functions (37): `taskApiQueueOptions`, `serveTaskApiOptions`, `serveTaskBoardPage`, `serveTaskList`, `serveTaskActivityStream`, `serveTaskCapabilities`, `serveTaskCapabilitiesCheck`, `serveTaskReviewLaneDrain`, `postTaskReviewLaneAct`, `postTaskReviewLaneLoop`, `postTaskReviewLaneRun`, `serveTaskCurrent`, `postCurrentTaskStep`, `postTaskCreate`, `postTaskClearPlan`, `serveTaskDetail`, `serveTaskPage`, `postTaskApiStep`, `postTaskApiContinueWork`, `postTaskApiClaim`, `postTaskApiMessage`, `postTaskApiChat`, `postTaskApiPlan`, `postTaskApiDo`, `postTaskApiBacklog`, `postTaskApiReviewChat`, `postTaskApiFinish`, `postTaskApiReady`, `postTaskApiAccept`, `postTaskApiRevise`, `postTaskApiReview`, `serveTaskEvents`, `serveTaskOperation`, `matchTaskApiRoute`, `handleTaskApi`, `createTaskApiServer`, `cmdServe`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
