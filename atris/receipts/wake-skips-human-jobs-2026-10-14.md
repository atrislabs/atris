# Wake leaves human decisions alone

Wake now excludes human-held jobs from a single member's task evidence. The frozen check passed: four cases, zero failures, exit 0. Automatic wake also selected only the ordinary checked job in a real command run.

## Plan

checked jobs -> skip human holds -> ordinary work, or idle

Risk: automatic wake and single-member wake use different selection paths. Safeguard: exercise both through the real CLI with isolated SQLite jobs and task evidence. No dependencies or member identity instructions changed.

## Files

- commands/member.js
- test/member-wake-skips-human-jobs.test.js
- atris/MAP.md
- atris/refs/MAP-NOTES.md
- atris/team/architect/logs/2026-10-14.md
- atris/receipts/wake-skips-human-jobs-2026-10-14.md

## Rerun

`node --test test/member-wake-skips-human-jobs.test.js`

Exit 0. Output: tests 4, pass 4, fail 0. Eight held tag placements and five legacy or normalized holds are covered. Mixed queues select one unheld job; held-only queues select zero. Planning leaves all jobs open and unclaimed.

## Real CLI proof

Fixture: two checked jobs tagged needs-human and decision, plus one ordinary checked job. All belong to demo. The temporary proof fixture is retained locally.

Working directory: `/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9`

Command:

```sh
ATRIS_TASKS_DB=/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9/tasks.db ATRIS_HOME=/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9/home ATRIS_SKIP_UPDATE_CHECK=1 node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-wake-skips-jobs-tagged-needs-human-o-20261014-133158/bin/atris.js member wake demo --keep --dry-run
```

Exit: 0.

Output:

```text
would start demo on: Fix the example typo
```

Working directory: `/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9`

Command:

```sh
ATRIS_TASKS_DB=/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9/tasks.db ATRIS_HOME=/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9/home ATRIS_SKIP_UPDATE_CHECK=1 node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-wake-skips-jobs-tagged-needs-human-o-20261014-133158/bin/atris.js member wake demo --plan --json
```

Exit: 0.

Output:

```json
{
  "task_count": 3,
  "candidate_count": 1,
  "candidates": [
    "Fix the example typo"
  ],
  "needs_user": false,
  "receipt_path": "/private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-wake-proof-RKASv9/atris/runs/member-wake-demo-2026-10-14T13-34-31-776Z.json"
}
```

## Scope notes

The task is in Review after its own required check exited 0. Check receipt: `atris/runs/2026-10-14-task-01m4x9ppfqhj2gksfm9zhj2gks-2026-10-14T13-35-46-970Z.json`. The mission completion command returned exit 3 because the calling mission harness still owns the live lock, held by pid 36437. The lock was left untouched; the harness can finish the mission after this receipt returns. No human asks remain for this change.

Brain activation and compile returned plan-only, exit 2, because this checkout has no compiled brain; generating unrelated policy files was left outside this slice. A task note regenerated this checkout's rendered TODO with an empty local board; only that generated change was restored to its initial contents. The existing task remains claimed by architect in the main workspace.

next_push: Show why each human-held job was skipped in the wake preview.

layer: behaviors

