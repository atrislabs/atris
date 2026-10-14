Earlier failure footers now keep their reason in narrower windows. The real member board command and all 37 required tests passed, exit 0.

Files edited: lib/member-board.js, test/member-board.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
Artifacts: atris/runs/member-board-compact-earlier-proof.py, atris/runs/member-board-compact-earlier-receipt.md; appended atris/team/builder/logs/2026-10-14.md.

Verify: node --test test/member-board.test.js test/member-result.test.js
Output: tests 37; pass 37; fail 0. Exit: 0.
Real surface: python3 atris/runs/member-board-compact-earlier-proof.py invokes node bin/atris.js member board --watch in a 47-column, 7-row terminal.
Output excerpt: 3 more not shown (1 earlier failure, timed out)
Exit: 0.

Progress: timeout reason needs 47 columns rather than 52; earlier failure count stays complete at 36 columns. Regression covers working, quiet, and finishing before sleep. Initial 45-column expectation failed, corrected to the measured 47-column boundary before final verification.
next_push: shorten the more-not-shown prefix before cutting failure counts in windows below 36 columns.
layer: behaviors
