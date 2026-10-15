# Every single-test rerun in a receipt still matches a board test

Some receipts rerun one board test by naming part of its title. If that test is renamed, the rerun matches nothing, runs zero tests, and still exits 0, so the receipt looks fine while proving nothing. A new check reads every checked-in receipt, finds each rerun aimed at the board test file, and fails if its pattern matches no board test title. Titles built inside loops are expanded into each of their real variants first. All nine such reruns in today's receipts still match a test. No product code changed.

Files edited: test/member-board.test.js; atris/refs/MAP-NOTES.md; atris/team/builder/logs/2026-10-14.md; this receipt.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`, run after every file in this change was written.

Teeth: a made-up rerun line aimed at a title no test has, added to the wide footer receipt, made the check fail (exit 1) and name that receipt. A rerun line aimed at a title that only exists once a loop title is filled in passed (exit 0), which shows the expansion works. The receipt was restored from git after each plant. The planted lines are described here, not quoted, so this receipt cannot trip the check itself.

next_push: when a receipt's rerun names two board test files or a pattern with alternatives, check each alternative matches a title on its own, so one dead branch cannot hide behind a live one.
