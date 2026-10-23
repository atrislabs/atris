# Saved XP and concurrent collection repair

Both reported failures reproduced before implementation. The requested XP suite now passes all 50 checks with exit 0, including actual concurrent CLI processes. The requested branch is updated without merging.

## Changed files

- `commands/xp.js`: import only verified linked receipt chains, deduplicate receipt and episode IDs, re-chain onto the durable head, and lock the complete collection transaction.
- `lib/career-xp-lock.js`: shared exclusive file lock, bounded retry, same-host dead-process recovery, and release on exceptions.
- `lib/task-db.js`: append task episodes under the same shared-root lock.
- `test/xp-workspace-root.test.js`: saved receipt recovery, duplicate evidence, source retention, checkout removal, deterministic real-process overlap, and lock lifecycle regressions.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: update the shared XP routes and references.
- This receipt. Local member log: `atris/team/validator/logs/2026-10-23.md`.

Plan: linked evidence -> shared lock -> deduplicated receipt chain -> correct totals.
Rollback: revert the commit containing this receipt.

## Failing proof before implementation

Command: `node --test --test-name-pattern='verified linked receipts|overlapping real collectors' test/xp-workspace-root.test.js`

Exit: 1. Both tests failed for the reported reasons:

```text
saved verified receipt must count without its episode
0 !== 1
real concurrent xp: {"agent_xp":0,"integrity":"tampered"}
actual: 'tampered'
expected: 'verified'
```

The race test pauses one process immediately after an actual filesystem read using a temporary test-only preload. Another actual CLI process collects, a second acceptance is appended, then the paused process resumes. No production delay or mock filesystem was added.

## Final verification

Rerun command: `node --test test/xp.test.js test/xp-command.test.js test/xp-workspace-root.test.js test/mission-xp.test.js`

Exit: 0. Exact output excerpt:

```text
real concurrent xp: {"agent_xp":2,"integrity":"verified"}
ℹ tests 50
ℹ suites 0
ℹ pass 50
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Real surface invocation: `node bin/atris.js xp --local --workspace /var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-proof-vP5g9Z`

A temporary workspace was seeded with the accepted-review fixture and removed after the invocation. Exit: 0. Exact output excerpt:

```text
AgentXP Card
AgentXP 1 | Today 1 | Career Level 1
Next career level 1/1,000 AgentXP (0.1%) | 999 to go
```

`git diff --check`: exit 0, no output.
`atris slop detect atris/MAP.md` and `atris slop detect atris/refs/MAP-NOTES.md`: exit 0, clean.
`atris brain activate --root . --verify` and `atris brain compile --root .`: exit 0, plan-only output. No unrelated generated policy files changed.

Progress: both blockers repaired; both regressions first failed, then passed. No new dependencies. Existing TODO changes remain unstaged. No acceptance or merge performed.

The prep brief omitted whether the race would reproduce on this machine and the actual branch state. Both were checked: the branch matched, and deterministic overlap reproduced the exact tampered-zero result. Only commands/xp.js writes the receipt ledger among commands and lib sources inspected.

Residual limits: existing already-tampered main ledgers remain fail-closed; this change prevents new overlap corruption and does not silently repair historical corruption. Other-host live locks time out rather than being stolen. The full repository suite was not run; the requested XP suite was run bare.

next_push: have an independent reviewer inspect the two repaired blockers before any merge.
layer: capabilities
