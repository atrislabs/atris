## Run-record one-lap case uses the shared fakes, 2026-10-14

The one-lap review case now uses the shared fake worktree setup, which writes the real setup's note file, and passes the land target the empty test room resolves to. The landed dispatch case still checks the real lookup against that value.

Proof: the one-lap case ran at 436ms and 419ms, versus 2019ms and 2335ms for the committed version. Taken alone, the land target took it to 920ms and the note to 1667ms. `node --test test/roster-run-record.test.js` exited 0 with `tests 12`, `pass 12`, `fail 0`. Full-file runs alternating old and new under falling load: old 26727ms then new 22399ms, old 20683ms then new 18361ms.

Metric: about 1.6 to 1.9 seconds off this case, every record assertion retained.

Files: test/roster-run-record.test.js, atris/refs/MAP-NOTES.md, atris/receipts/2026-10-14-run-record-one-lap.md, atris/team/auto-improver/logs/2026-10-14.md.

Lesson: the review-only path asks git for the land target through a longer route than a build dispatch, so it gained more from the direct value.

next_push: the remaining cost per dispatch is the engine run with sandbox teardown pauses and the machine process check, both in product code; profile the next slowest test file instead.
layer: capabilities
