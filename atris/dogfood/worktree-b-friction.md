# Worktree dogfood B — parallel mission friction notes (2026-06-10)

- start: second parallel `mission start --worktree` also clean; no index.lock contention with A.
- friction #1 (FIXED in CLI-212): main-checkout `mission status` showed only its local mission (1 of 3); rollup now lists A+B with `worktree:` source lines and worktree_root in JSON.
- observation: mission ids carry date+slug+random suffix, so cross-worktree id collisions are unlikely; rollup still dedupes by id defensively.
- friction #2 (open, small): `mission status` rollup re-reads every sibling worktree state file on each call; fine at this scale, revisit if worktree count grows.
