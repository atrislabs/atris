# Worktree dogfood A — parallel mission friction notes (2026-06-10)

- start: two `mission start --worktree` runs ~1s apart, no git lock collision; worktree + branch + baseline sidecar all created clean (dirty_count 0).
- friction #1 (FIXED in CLI-212): `mission status` from main checkout was blind to this mission; state_path lives inside the worktree. Fix: cross-worktree rollup in statusMission via worktree.js listWorktrees.
- boundary (by design): rollup is read-only status; tick/complete must run from inside the worktree so state writes land here.
- friction #2 (open, small): receipts + baselines live inside the worktree; pruning the worktree deletes proof — copy receipts out before `worktree prune`.
