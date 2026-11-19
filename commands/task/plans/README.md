# plans

A task's public plan: choosing the owner from the team, the plan card, plan preview and the plan trace.

Owner: `navigator` (atris/team/navigator/MEMBER.md)

Moved out of `commands/task.js` on 2026-11-16.

Uses code from: [projection](../projection/README.md), [core](../core/README.md), `commands/task.js` itself.

## Files

### plans.js

Functions (17): `parseMemberFrontmatter`, `readTeamMembers`, `scoreTeamMember`, `plainMemberDescription`, `chooseTaskOwner`, `isGenericPlanActor`, `taskTextMentionsActor`, `buildPublicPlan`, `renderPublicPlan`, `planTraceData`, `planTraceNote`, `traceLineFromContent`, `latestTraceValue`, `taskHasTrace`, `taskPurpose`, `cmdPlanPreview`, `buildAutomaticPlanTrace`

## How this folder works

This code moved out of `commands/task.js` unchanged, except that `__dirname` became `MAIN_DIR` (the folder of `task.js`) and relative requires point out of this folder. Every name it borrows, from `task.js` or from another folder, arrives through `bindMain()`, which `task.js` calls as the last step of loading. `task.js` takes these functions back with one `require` near its top, so every old name still works there.

New work for this feature goes here, not in `task.js`. To use a new name from outside this folder, add it to the `let` list and the `bindMain` list at the top of the file, and to this folder's `bindMain({...})` call at the bottom of `task.js`.
