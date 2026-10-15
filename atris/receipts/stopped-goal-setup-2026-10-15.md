
## Stopped goal setup improvement
- Changed: removed one setup launch while retaining every stopped-goal assertion.
- Files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md.
- Proof: node --test --test-name-pattern='member goal-from-mission names stale goals when the mission turns stopped' test/commands.test.js
- Output: pass 1, fail 0; exit 0.
- Required proof: node --test test/roster-run-record.test.js && node bin/atris.js slop --staged
- Output: pass 12, fail 0; exit 0. Staged writing check recorded below.
- Metric: one fewer setup launch; focused case 459.3 ms before and 345.0 ms after in single runs.
- Learned: the shared member scaffold preserves the fixture while real goal commands keep behavior coverage.
- next_push: replace the completed proof-history test member setup launch.
layer: capabilities
