# Random boards with wide-character names fit every size by screen cells

Chinese, Japanese, and Korean letters take two screen cells each, so a board line can fit by letter count and still wrap. The existing randomized size test used plain names and counted letters, so it could not see that. A new seeded test draws random boards with wide-character member names and jobs, failed, finished, live, and dead runs, at every width from 1 to 130, four heights, and with or without hidden older runs, and checks every line by screen cells. Its own cell count covers only the wide ranges the fixtures use, so it does not grade the board's width table with itself. The board passes everywhere today. No product code changed.

Files edited: test/member-board.test.js; atris/MAP.md and atris/refs/MAP-NOTES.md (59 refs into the board tests moved down 41 lines, plus one new note); atris/team/builder/logs/2026-10-14.md; this receipt.

Teeth: with the board planted to count every letter as one cell, `node --test --test-name-pattern="wide names and jobs" test/member-board.test.js` failed (exit 1) at 16 columns, where wide names ran past the width and the columns no longer lined up. The older letter-count test passed on the same planted code (exit 0), so it could not have caught this. The board code was restored from git afterward.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`, run last, after every file was written and staged.

next_push: the live watch redraw draws a short hint line under the board; check the hint and board together by screen cells when member names are wide, on a real pseudo-terminal at 1 to 12 columns.
