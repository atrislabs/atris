# Feature folders of commands/task.js

`commands/task.js` was 12519 lines. On 2026-11-16 `lib/split-file.js` moved 425 functions out of it into these folders, each with an owner. 829 lines stay: the requires and constants, code that runs while the file loads, and the functions the plan keeps.

| Folder | Owner | Files | Lines | What it is |
|---|---|---|---|---|
| [core](core/README.md) | shared | 1 | 154 | Small helpers that several task features use: finding a task by its id, quoting, plain public words. |
| [review-evidence](review-evidence/README.md) | `validator` | 1 | 1266 | What a reviewer reads about a task: the review summary, the proof and evidence commands, the review chat handoff, and follow-up tasks a review asks for. |
| [projection](projection/README.md) | unassigned | 1 | 574 | The task projection file and what it carries: goals matched to tasks, task streams, approvals, missions and wishes, and the payload sent to the cloud. |
| [board](board/README.md) | unassigned | 1 | 1175 | The everyday board commands: add, list, status, day, home, keep, delegate, claim, release, and moving a task between plan, doing and backlog. |
| [next](next/README.md) | `task-planner` | 1 | 1153 | Choosing what to work on: the queue and its scopes, the current task, next, endgame seed tasks and continue-work. |
| [capabilities](capabilities/README.md) | `validator` | 1 | 777 | The task API's capability contract and the self-check that proves the review lane behaves as the contract says. |
| [review-lane](review-lane/README.md) | `validator` | 1 | 941 | The review lane: drain, act, loop and run, which work through tasks waiting for review. |
| [reviews](reviews/README.md) | `validator` | 1 | 534 | The reviews queue people read, review chat on a task, and sending a task back with revise. |
| [audit](audit/README.md) | `validator` | 1 | 263 | Task audits and the review command: rerun a task's checks and record what they show. |
| [card](card/README.md) | unassigned | 1 | 665 | Reading and changing one task: note, retitle, tag, chat, inspect, show, the task page and its next action. |
| [plans](plans/README.md) | `navigator` | 1 | 351 | A task's public plan: choosing the owner from the team, the plan card, plan preview and the plan trace. |
| [results](results/README.md) | `launcher` | 1 | 378 | A task's public result: the result card, the accept receipt, agent XP, scorecards and the result log. |
| [steps](steps/README.md) | `executor` | 1 | 649 | Working a task step by step: step options, running a step, the current step, and step. |
| [closing](closing/README.md) | `launcher` | 1 | 571 | Closing and cleaning up tasks: done, finish, archive, reopen, clear-done, pruning test junk, reaping blockers and relabeling archived tasks. |
| [landing](landing/README.md) | `orb` | 1 | 1768 | Landing a task: ready with proof, receipts, accept and accept-group, certify-verified, auto-accept and the sweep. |
| [todo-sync](todo-sync/README.md) | unassigned | 1 | 717 | Moving tasks between the task store and files: import, export, events, lineage, setup, where, render to TODO.md and sync. |
| [api](api/README.md) | unassigned | 1 | 713 | The local task API server behind atris task serve: its routes, reads and writes. |

Shared code in `core` has no single owner: a change there needs a look from the owners of the folders that use it.

## How the split was made and proven

The plan is `commands/task/split-plan.json`. The order file `commands/task/split-order.json` lists every top-level piece of the original in its old position.

```
node lib/split-file.js analyze --plan commands/task/split-plan.json
node lib/split-file.js split   --plan commands/task/split-plan.json
node lib/split-file.js rebuild --plan commands/task/split-plan.json --out /tmp/task.js
node lib/split-file.js verify  --plan commands/task/split-plan.json
```

`verify` rebuilds the original from these folders and diffs it, runs `node --check`, loads every file and counts names used but never defined. It proves the split itself; once someone edits a moved function, the rebuild differs from the original on purpose.
