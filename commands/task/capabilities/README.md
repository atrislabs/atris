# capabilities

The task API's capability contract and the self-check that proves the review lane behaves as the contract says.

Owner: `validator` (atris/team/validator/MEMBER.md)

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [review-evidence](../review-evidence/README.md), [next](../next/README.md), [review-lane](../review-lane/README.md), `commands/task.js` itself.

## Files

### capabilities.js

Functions (13): `taskQueueCapabilities`, `taskCapabilitiesContract`, `stableCapabilityJson`, `capabilityValuesEqual`, `capabilityCheck`, `reviewLaneDrainBehaviorConformance`, `taskReviewLaneActDecision`, `reviewLaneActBehaviorConformance`, `reviewLaneLoopBehaviorConformance`, `reviewLaneRunBehaviorConformance`, `taskCapabilitiesCheckReport`, `cmdCapabilities`, `cmdCapabilitiesCheck`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
