
## Completed member goal setup
- Changed: removed one setup launch while keeping both completed-goal command checks.
- Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
- Focused proof: node --test --test-name-pattern='member goal-from-mission stops when active mission is complete' test/commands.test.js
- Output: tests 1, pass 1, fail 0; exit 0. Case time: 518.1 ms before, 394.5 ms after, one sample each.
- Required proof: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
- Output: tests 12, pass 12, fail 0; clean, no slop tells in 3 files; exit 0.
- Metric: one fewer setup launch; no assertions removed.
- Learned: completed-goal reads append notes, so keep them sequential and use the production member builder for setup instead.
- next_push: replace another setup-only member creation launch with the production member builder.
layer: capabilities
