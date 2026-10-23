# Saved XP repair synchronized and proved

The saved repair preserves verified linked receipts without source episodes and serializes shared ledger collection. This increment merged current origin/master into the requested repair branch and verified the existing repair. It adds no runtime changes or dependencies and does not merge the pull request into master.

## Scope and state

Plan: inspect saved repair -> run bare XP suite -> merge current master -> resolve map conflict -> rerun bare suite and real CLI -> record -> push -> stop.

Requested branch: codex/validator-agentxp-stopped-counting-atris-xp-lo-20261023-034242.
Existing repair: 03e6a8f61. Its failing-first evidence for both review blockers is already saved in atris/receipts/agentxp-review-blockers-2026-10-23.md. No attempt was made to rewrite that history or claim a new red run.
Current master merged: 11f0e4e46. Merge: 1be72125c. The merge conflict was confined to atris/MAP.md; both the XP route and the updated HTTP route were preserved. There were no incoming changes to commands/xp.js, lib/task-db.js, lib/career-xp-lock.js, or test/xp-workspace-root.test.js in this merge.

Edited files: atris/MAP.md (merge resolution), atris/refs/MAP-NOTES.md (XP references checked against current source), this receipt. Member log appended at atris/team/validator/logs/2026-10-23.md. Existing atris/TODO.md changes and the pre-existing untracked atris/receipts/agentxp-master-sync-2026-10-23.md are left untouched and unstaged.
Rollback: revert this increment's documentation commit and revert merge 1be72125c with its first parent if synchronization must be undone.

## Verification

Bare command before and after the current merge:

```sh
node --test test/xp.test.js test/xp-command.test.js test/xp-workspace-root.test.js test/mission-xp.test.js
```

Both runs exited 0. Exact output excerpt from the final run:

```text
✔ verified linked receipts survive missing episodes and deduplicate recovered episodes (3626.0335ms)
✔ overlapping real collectors cannot append against a stale receipt head (2781.9405ms)
ℹ real concurrent xp: {"agent_xp":2,"integrity":"verified"}
ℹ tests 50
ℹ suites 0
ℹ pass 50
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36297.026
```

Actual CLI invocation against an owned temporary workspace seeded from test/fixtures/xp/accepted-review.json:

```sh
node bin/atris.js xp status --local --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/agentxp-current-proof-NRw2Pg
```

Exit 0. Exact output excerpt:

```text
AgentXP Card
AgentXP 1 | Today 1 | Career Level 1
Next career level 1/1,000 AgentXP (0.1%) | 999 to go
```

The temporary fixture was removed after invocation. The bare suite also invokes actual account-status and concurrent CLI processes. No mission guard rejected either run.

Scoped `git diff --check -- atris/MAP.md atris/refs/MAP-NOTES.md atris/receipts/agentxp-third-try-sync-2026-10-23.md`: exit 0, no output. `atris brain compile --root .`: exit 2, plan-only proposed generated files; none were written. `atris task note vas-10`: exit 0, `noted VAS-10 v9`. The task remains in Review.

## Limits and next step

Progress: both original blocker regressions passed, all 50 requested checks passed before and after the new merge, and the real CLI displayed the expected earned point. The existing task is already in Review and remains unaccepted. No full repository suite was run.

The prep brief lacked live branch state: a previous main merge was committed but not pushed, and newer main changes were still missing. This increment closed that synchronization gap. Its added scenarios were not undertaken as a second slice: deleted legacy-only receipt files cannot be recovered after checkout removal without another retained copy; acceptance under a held lock and timeout after database mutation still need targeted reproduction. The current bounded wait is unchanged, and this receipt does not certify transactional acceptance under timeout. Before merging, prefer moving lock acquisition ahead of task mutation if that reproduction confirms partial completion, rather than merely increasing the wait.

Other existing limits: any invalid linked receipt chain is excluded as a whole, an already-tampered main ledger stays fail-closed, and live locks on other hosts time out rather than being stolen.

next_push: reproduce acceptance during a held ledger lock, including timeout, and prevent partial task completion if confirmed.
layer: capabilities
