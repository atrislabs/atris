
# Member help read batching

Ran the two independent member usage checks together, retaining every assertion.

- Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
- Focused command: node --test --test-name-pattern='member create --help' test/commands.test.js
- Output: tests 1, pass 1, fail 0; exit 0; case time 119.8 ms.
- Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
- Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
- Metric: two sequential CLI waits become one; no assertions removed.
- Learned: both usage paths return before any member file writes, so they can overlap safely.
- next_push: batch another pair of independent member display reads.
layer: capabilities
