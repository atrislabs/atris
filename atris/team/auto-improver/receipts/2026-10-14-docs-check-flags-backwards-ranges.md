The docs check now flags a line range whose end comes before its start, instead of passing it or rewriting it still backwards; a new test fails without the change and passes with it, and the 35 required checks passed, exit 0.

Files edited: lib/map-refs.js; test/doc-health.test.js; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-docs-check-flags-backwards-ranges.md.

Rerunnable verification command:
`node --test --test-name-pattern='end comes before its start' test/doc-health.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
with fix exit=0
✔ a range ref whose end comes before its start is not right, and fix-refs leaves it for a human (176.714709ms)
ℹ tests 1
ℹ pass 1
without fix exit=1
✖ a range ref whose end comes before its start is not right, and fix-refs leaves it for a human (92.352458ms)
    actual: [ [ 5, 'moved' ] ],
doc+map tests exit=0
ℹ tests 50
ℹ pass 50
doc-health exit=0
{ total: 1118, ok: 1115, flagged: 3 }
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

What was wrong before: a backwards range with no code name beside it only had its lines checked against the file length, so it passed. A backwards range with a code name beside it was marked as moved, and the fixer kept its negative width when rewriting it, so it stayed backwards at a new spot. Now both are reported as broken with the reason "range ends before it starts", and the fixer leaves them for a human, because nobody can know the intended end line.

Guard on the real notes: the existing test that fails the suite when a map ref points at no code now also fails on any backwards range, so the 15 fixed last tick cannot come back unnoticed.

Real notes: the same 3 refs were flagged before and after the change (all three already marked as matching more than one place), so the change adds no new failures.

Metric: backwards ranges that pass the docs check silently went from all of them to none.

Commands and artifacts: atris mission status; git status; reading the ref checker and its tests; new test run with and without the change; all doc and map ref test files (50 of 50); atris doc-health on the real notes before and after; frozen verifier; grep showing no map refs into the edited files.

next_push: Return to test speed: time the status default test and the other status tests, and swap the full workspace setup for a bare folder where the test writes every file it reads.
layer: capabilities
