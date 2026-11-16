# review-evidence

What a reviewer reads about a task: the review summary, the proof and evidence commands, the review chat handoff, and follow-up tasks a review asks for.

Owner: `validator` (atris/team/validator/MEMBER.md)

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [projection](../projection/README.md), [board](../board/README.md), [next](../next/README.md), [reviews](../reviews/README.md), `commands/task.js` itself.

## Files

### review-evidence.js

Functions (69): `reviewNextTaskTitle`, `rawReviewNextTaskTitle`, `reviewNextTaskTitleIsSpecific`, `normalizeReviewNextTaskInput`, `genericContinuationIssues`, `findExistingReviewNextTask`, `buildReviewFollowUpChildPredicate`, `taskEventOrderValue`, `eventIsTaskReviewChat`, `eventClearsPendingReviewChat`, `buildPendingReviewChatPredicate`, `createReviewNextTask`, `createNextTaskIfRequested`, `continueWorkCommandForTask`, `certifiedReviewNextAction`, `proofBoundaryBlockedEvaluation`, `handoffAllowsHumanAccept`, `handoffIsProofBoundaryBlocked`, `reviewSummary`, `titleToResultText`, `proofToReasonText`, `proofToHumanCheck`, `taskReviewFormatCommandList`, `taskReviewProseCheckLabels`, `taskReviewLandingTested`, `landingPayloadValue`, `taskReviewLanding`, `taskReviewResult`, `taskReviewSavedText`, `cleanReviewProofText`, `reviewMessageLooksLikeProof`, `taskReviewEventProof`, `taskReviewProofFallback`, `reviewReceiptPath`, `withReviewReceiptPath`, `taskReviewSummary`, `taskReviewInspectMetadata`, `taskInspectFieldValues`, `reviewSummaryWithVerificationChat`, `reviewLandingForDisplay`, `printReviewLanding`, `latestTaskEvent`, `verifiedProofCommand`, `autoCertifyCommandCandidatesForTask`, `reviewBlockerForTask`, `reviewHandoffForTask`, `reviewActor`, `taskReviewClip`, `taskReviewFullEvidence`, `taskReviewEvidencePaths`, `taskReviewCommandLooksSpecific`, `taskReviewUnescapedQuoteCount`, `taskReviewCommandStartsInsideQuote`, `taskReviewWithoutQuotedSegments`, `taskReviewTrimOutsideQuotedTail`, `taskReviewTrimTrailingOutsideQuote`, `taskReviewCleanEvidenceCommand`, `taskReviewSplitEvidenceClauses`, `taskReviewCommandIsDescribedSubject`, `taskReviewEvidenceCommands`, `taskReviewRecentThread`, `taskReviewObjective`, `taskReviewVerificationFocus`, `taskReviewSpecificCodexPrompt`, `taskReviewChatHandoff`, `taskWithReviewEvidence`, `taskWithAgentCertification`, `taskReviewChatContract`, `taskReviewChatNote`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
