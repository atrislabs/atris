# Cleanup proof scripts no longer run when a check loads them

Five of the nine cleanup proof scripts built their real Git fixtures as soon as any program loaded them. The pre-commit check loads every staged script, so committing one of these files ran its whole timing proof inside the commit, about a minute for all five, and left a temporary repository behind each time. Running inside a commit is also where inherited Git settings can damage the index.

Each of the five now stops at load unless it is run directly. Running them directly, as the required checks do, is unchanged.

## Proof

Loading each script, before:

```
before land-moved-dirty-folder-check          load exit 0, 4s, 8 output lines, fixtures: 1
before land-vanishing-folder-check            load exit 0, 31s, 42 output lines, fixtures: 1
before tidy-vanishing-folder-check            load exit 0, 23s, 62 output lines, fixtures: 1
before worktree-cleanup-moved-folder-check    load exit 0, 3s, 9 output lines, fixtures: 1
before worktree-cleanup-moved-lock-check      load exit 0, 2s, 9 output lines, fixtures: 1
```

After:

```
after  land-moved-dirty-folder-check          load exit 0, 0s, 0 output lines
after  land-vanishing-folder-check            load exit 0, 0s, 0 output lines
after  tidy-vanishing-folder-check            load exit 0, 0s, 0 output lines
after  worktree-cleanup-moved-folder-check    load exit 0, 0s, 0 output lines
after  worktree-cleanup-moved-lock-check      load exit 0, 0s, 0 output lines
```

The real pre-commit load check with all five staged, and the required checks that run them directly:

```
node scripts/precommit-load-check.js
load check exit: 0, 0s
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 33, pass 33, fail 0, exit 0
```

## Files

- atris/receipts/2026-10-14-land-moved-dirty-folder-check.js
- atris/receipts/2026-10-14-land-vanishing-folder-check.js
- atris/receipts/2026-10-14-tidy-vanishing-folder-check.js
- atris/receipts/2026-10-14-worktree-cleanup-moved-folder-check.js
- atris/receipts/2026-10-14-worktree-cleanup-moved-lock-check.js
