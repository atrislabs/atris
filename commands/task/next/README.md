# next

Choosing what to work on: the queue and its scopes, the current task, next, endgame seed tasks and continue-work.

Owner: `task-planner` (atris/team/task-planner/MEMBER.md)

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [projection](../projection/README.md), [review-evidence](../review-evidence/README.md), [board](../board/README.md), [capabilities](../capabilities/README.md), [core](../core/README.md), [card](../card/README.md), [todo-sync](../todo-sync/README.md), `commands/task.js` itself.

## Files

### next.js

Functions (50): `taskQueueColumnKey`, `sortTasksNewestFirst`, `sortTasksOldestFirst`, `taskQueueItem`, `taskQueueLimit`, `cleanTaskScopeValue`, `normalizeTaskQueueScope`, `taskQueueScopeFromArgs`, `taskQueueScopeFromSearchParams`, `taskQueueScopeFromBody`, `mergeTaskQueueScopes`, `taskQueueScopeIsEmpty`, `taskScopeEquals`, `taskGoalScopeValues`, `taskReviewStateMatches`, `taskMatchesScopeTag`, `taskMatchesQueueScope`, `filterTasksByScope`, `taskQueueScopeWithoutReviewState`, `taskReviewStateCounts`, `taskHasReviewFollowUpChild`, `taskQueueReviewStateCounts`, `taskReviewStateActionSample`, `normalizeTaskIdSet`, `taskHasPendingReviewChat`, `pendingReviewChatActionSample`, `taskQueueReviewStateActions`, `formatTaskQueueScope`, `noOpenTasksMessage`, `taskQueueContract`, `selectTaskForCurrent`, `taskCurrentContract`, `buildTaskCurrent`, `printTaskCurrent`, `printTaskQueue`, `cmdCurrent`, `cmdQueue`, `suggestNextClaimableTask`, `liveTaskWithTitle`, `readEndgameAgentAction`, `shellQuoteTaskArg`, `buildEndgameTaskSeed`, `createEndgameSeedTask`, `nextActionFromCommand`, `cmdNextTruth`, `reportSkippedDecisionsAndExit`, `isUninitializedTaskFolder`, `cmdNext`, `continueWorkForReviewTask`, `cmdContinueWork`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
