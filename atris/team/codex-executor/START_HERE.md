# Start Here - Codex Executor

1. Run `node bin/atris.js task current --json` and take only work claimed by `codex-executor`, explicitly assigned to Codex, or requested by the current operator.
2. If Review has certified tasks, stop build work and hand the checkpoint to the operator: accept approved proof or revise stale proof.
3. Read `atris/MAP.md`, the task note, and the exact files named by the task before editing.
4. For mechanical build work, make one scoped patch, then run the named verifier or the narrowest regression before broadening to `npm test`.
5. Hand off with changed files, verifier output, residual risk, and the next review-ready move.

Proof target:

- `atris brain activate --member codex-executor --root . --verify` exits 0.
- The activation card names concrete task, review, or planning handoff work instead of a missing `START_HERE.md` setup card.
