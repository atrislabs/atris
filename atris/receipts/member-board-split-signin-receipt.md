# Split sign-in failures on small screens

Extended the real terminal check to cover signed-out results written in parts. Runtime behavior needed no change.

Plan: idle -> split start -> working -> split signed-out result stays working -> newline shows signed out -> old log restores idle.

Files edited: test/member-board.test.js; atris/receipts/member-board-idle-transition-proof.py; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md (new entry only).
Artifacts: atris/receipts/member-board-split-signin-output.txt; atris/receipts/member-board-split-signin-receipt.md.

Verify: node --test test/member-board.test.js test/member-result.test.js
Runtime: Node v25.6.1
Exit: 0
Output: tests 96; pass 96; fail 0; cancelled 0; skipped 0; todo 0.

Real command, invoked by the regression through Python's standard-library terminal: node bin/atris.js member board --watch
Exit: 0 in all ten cases. Output excerpts:

```text
18x3: member  state
      bui...  signed out
30x3 and 47x2: builder  failed  signed out
60x3: builder  done failed  signed out   4s ago  sign in to claude
split sign-in failures wait for newline; guidance fits at 60 columns
```

Progress: four new signed-out cases, covering three small layouts and one guidance layout; ten total terminal transitions, all within screen dimensions. Partial failures stay working across a periodic redraw and until the final newline. All children exit 0 on interrupt.

Learning: 18 columns uses signed out as the whole state. At 47 columns the compact result keeps the reason; 60 columns keeps the sign-in instruction. The first proof attempt wrongly expected failed at 18 columns, and the first full run wrongly expected guidance at 47 columns; expectations were corrected to the existing useful behavior, then the full check passed.

Other checks: git diff --check exited 0; atris slop detect test/member-board.test.js exited 0, clean. The Python file is outside the slop scanner's supported files. Brain activation and compilation returned plan-only, exit 2; generated policy files were left unchanged. Mission attachment reported the existing runner's lock busy; its state was preserved.

Review readiness: the task gate also ran `/opt/homebrew/bin/node --test test/member-board.test.js test/member-result.test.js` and exited 0; task is in Review. Its absolute executable path requires independent review before automatic acceptance. Gate receipt: atris/runs/2026-10-15-task-bci-17-2026-10-15T03-08-15-778Z.json. No human acceptance was performed.

next_push: Prove a split signed-out result followed by a new run on another engine preserves the earlier failure without showing stale sign-in advice.
layer: behaviors
