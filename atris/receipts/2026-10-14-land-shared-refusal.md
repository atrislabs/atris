# Land uses the shared check after Git refuses a removal

Land was the last cleanup with its own copy of the check that runs after Git refuses to remove a work folder. It now uses the same shared check as member tidy, automatic cleanup, and worktree cleanup, so all four report a refused or moved folder the same way and a future fix lands in one place.

Output is unchanged. A new eighth timing case, where the folder moves while Git refuses, passed on the old code first and passes on the new code, so it pins the behavior across the switch.

## Proof

Old code, new moved case added:

```
node atris/receipts/2026-10-14-land-vanishing-folder-check.js
kept, needs a human: .../refused-moved/landed-copy (folder is missing; git lock: .../repo/.git/packed-refs.lock (14400s old), .../repo/.git/worktrees/landed-copy/index.lock (10800s old), ...
all eight timing cases passed; Git refusal after a passing check named three locks and distinct ages, also when the folder moved; ...
exit 0
```

New code:

```
node atris/receipts/2026-10-14-land-vanishing-folder-check.js
kept, needs a human: .../refused/landed-copy (git locks: .../repo/.git/packed-refs.lock (14400s old), .../repo/.git/worktrees/landed-copy/index.lock (10800s old), ...
kept, needs a human: .../refused-moved/landed-copy (folder is missing; git lock: .../repo/.git/packed-refs.lock (14400s old), ...
all eight timing cases passed; ...
exit 0
```

Required checks and land tests:

```
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 32, pass 32, fail 0, exit 0
node --test test/land*.test.js
tests 54, pass 54, fail 0
```

## Files

- commands/land.js: refusal path uses the shared check
- atris/receipts/2026-10-14-land-vanishing-folder-check.js: eighth case, folder moves while Git refuses
- test/worktree-removal-guard.test.js: expects eight cases
- atris/refs/MAP-NOTES.md: refusal ref now names the shared check
