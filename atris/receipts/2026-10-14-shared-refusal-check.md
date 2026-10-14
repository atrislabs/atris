# One shared check after Git refuses a removal

Member tidy and automatic regression cleanup each carried their own copy of the check that runs after Git refuses to remove a work folder. The two copies had already drifted once: tidy learned to handle a folder that moves during the refusal one tick before automatic cleanup did.

Both now call one shared check in the Git activity library. It reports the lock files and their ages when the folder is still there, and reports the folder as missing with its private and shared locks when it moved. Behavior is unchanged, so any future fix lands in both places at once.

## Proof

Direct test of the shared check, in place, moved with a lock, and moved with no lock:

```
node --test --test-name-pattern="shared check" test/worktree-removal-guard.test.js
pass 1, fail 0
```

Real cleanup routines, unchanged output for refusal in place and refusal after a move:

```
node atris/receipts/2026-10-14-autopilot-folder-check.js
"slug":"late-refused" ... "reason":"git locks: ..."
"slug":"late-refused-moved" ... "reason":"folder is missing; git lock: ..."
exit 0

node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js
kept  landed-copy  landed, but git refused: ...; git locks: ...
kept  landed-copy  landed, but git refused: ...; folder is missing; git lock: ...
all eight timing cases passed
exit 0
```

Required checks:

```
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
tests 31, pass 31, fail 0, exit 0
```

## Files

- lib/git-activity.js: shared after-refusal check
- lib/member-tidy.js, commands/autopilot.js: use it
- test/worktree-removal-guard.test.js: direct test of the three outcomes
- atris/refs/MAP-NOTES.md: refreshed refs
