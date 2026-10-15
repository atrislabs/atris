One-row idle wake and resize now have a real terminal regression check; the frozen board and result tests passed with exit 0.

Files edited: test/member-board.test.js; atris/receipts/member-board-idle-wake-proof.py; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-15.md (local member memory); this receipt.

Before: idle -> work arriving -> larger screen had no combined real-terminal check. After: one process is checked at 18x1 idle, 18x1 working, 18x3 working, and back to 18x1. No production behavior changed. Progress: one new regression, four exact terminal frames.

Real surface command: python3 atris/receipts/member-board-idle-wake-proof.py
Exit: 0

```text
command: node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/builder-continue-improving-atris-member-boar-20261015-003022/bin/atris.js member board --watch
18x1 idle: idle. 3 older
18x1 working: 1 hidden. 2 older
18x3 working: member   state | builder  working | 2 older hidden
18x1 working again: 1 hidden. 2 older
exit: 0
one-row idle board wakes; headings return after resize
```

Rerun: node --test test/member-board.test.js test/member-result.test.js
Exit: 0

```text
ℹ tests 123
ℹ suites 0
ℹ pass 123
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 62155.336792
```

The prior reported timeout and signed-out output also passed during the baseline run (122 passed, 0 failed, exit 0). These were expected CLI fixture lines, not assertion failures. The carried-forward branch has no commits missing from this checkout. The mission is locked by the current launcher; its state and frozen check were left alone. The initial TODO change was left unstaged. Brain activation and compile returned plan-only output; no policy files were regenerated.

next_push: check a split timeout result arriving while a one-row watch screen grows to three rows, preserving its hidden count until the newline arrives.
layer: behaviors
