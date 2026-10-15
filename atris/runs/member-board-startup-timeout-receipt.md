# Opening board waits for complete timeout lines

The opening board now keeps a member working while its timeout line is incomplete. The real command emitted one finished event after the newline, and all required checks passed.

Plan: pending timeout before startup -> working snapshot -> no event -> complete line -> one timeout event -> no duplicate.

Files edited: lib/member-board.js; test/member-board.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md.
Artifacts: atris/runs/member-board-startup-timeout-proof.py; this receipt.

Verify: node --test test/member-board.test.js test/member-result.test.js
Output: tests 69; pass 69; fail 0; cancelled 0; skipped 0; todo 0; exit 0.
Before the fix: the new live test failed because the startup snapshot said done failed for the incomplete timeout. After the fix, both startup variants pass, including started, step, finished, new-member and duplicate suppression checks.

Real surface: python3 atris/runs/member-board-startup-timeout-proof.py
Command invoked: node bin/atris.js member board --json --follow
Output excerpt:
```text
snapshot: member builder, state working, last_result empty
incomplete timeout: no event after 1.2 seconds
{"member": "builder", "mission": "m-proof", "kind": "finished", "text": "failed (timed out)", "ok": false}
completed timeout: exactly one event
exit: 0
```
The script prints the full actual JSON records with the current timestamp.

Commands: atris brain activate --root . --verify (plan-only, exit 2); atris mission status mission-2026-10-14-continue-improving-atris-mem-52869ba8 (exit 0); atris mission goal --json (no candidate, exit 0); atris mission attach-task 34 --json (driver lock busy, no mission changed); git status; atris task list/new/claim/note; python3 atris/runs/member-board-startup-timeout-proof.py (exit 0); node --test test/member-board.test.js test/member-result.test.js (exit 0); git diff --check (exit 0); atris brain compile --root . (plan-only, exit 0).
Preserved unrelated changes: atris/TODO.md and test/member-board-last-result.test.js. No mission settings changed.

Progress: one premature-result bug fixed; one added live startup scenario; 69 required checks pass, up from 68. The live proof covers one polling interval before and after completion.
next_push: Prove live follow preserves a non-ASCII progress message split inside a multibyte character.
Readiness: task BCI-2 is in Review, not accepted. Supported-runtime readiness command PATH=/opt/homebrew/bin:$PATH node --test test/member-board.test.js test/member-result.test.js exited 0. Saved receipt: atris/runs/2026-10-15-task-bci-2-2026-10-15T00-45-44-638Z.json. This command remains outside automatic certification's allowlist; no acceptance or policy change was attempted. The frozen command separately passed directly.
Landing: committed and pushed to origin; unrelated edits excluded.
layer: behaviors
