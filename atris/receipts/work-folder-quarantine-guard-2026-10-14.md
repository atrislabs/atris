# Sandbox cleanup keeps a locked quarantine store

Fleet review cleanup now checks the shared Git store and the quarantine store for an active write before it deletes anything. Before this, a lock in the quarantine store did not stop cleanup, which deleted the store and logged it as a normal removal.

## What changed

- `commands/worktree.js`: the marker check that already guarded work folders can now run against any Git store directly. The work folder check reuses it.
- `lib/fleet.js`: sandbox cleanup checks the work folder, the shared store, and the quarantine store, all before the first removal, so a lock never leaves a half-deleted sandbox.
- `test/worktree-removal-guard.test.js`: a real-Git test puts HEAD.lock in a bare quarantine store and requires the whole sandbox to stay, with no removal record.
- `atris/refs/MAP-NOTES.md`, `atris/MAP.md`: refs moved by this edit, plus older drift the ref fixer corrected.

## Proof

New test against the old cleanup code: exit 1, 0 passed, 1 failed. It catches the bug.

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`: exit 0, 24 passed, 0 failed (was 23).

`node atris/receipts/work-folder-quarantine-probe.js --require-protection`: exit 0.

```text
unlocked quarantine: removed true, store kept false, removal logged true
locked quarantine: removed false, store kept true, removal logged false
review gaps: 0; only disposable fixture repositories touched
```

All 19 worktree, tidy, and sandbox test files run one at a time: exit 0, 98 passed, 0 failed. Run in parallel, six files timed out together at about 10.5 seconds each. That was contention, since the same files pass alone.

`atris slop detect` on the three code files and the map notes: clean.

next_push: repair the source scan so the four known gaps in `node atris/receipts/work-folder-scan-probe.js --require-protection` close, starting with deletes inside a callback.

layer: capabilities
