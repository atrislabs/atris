# Member goal row setup

Removed one setup program launch while retaining every original assertion.

- Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
- Focused command: node --test --test-name-pattern='member goal-from-mission creates a bounded goal without a human title' test/commands.test.js
- Output: tests 1, pass 1, fail 0; exit 0.
- Metric: one fewer launch; single-run case time 698.8 ms before and 536.3 ms after. Timing is illustrative.
- Required command: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
- Required output: tests 12, pass 12, fail 0; clean, no slop tells; exit 0.
- Learned: member goal discovery reads the saved task view, so direct row setup must also save the production projection.
- next_push: replace another setup-only launch before a member display check, preserving its saved view.
layer: capabilities
