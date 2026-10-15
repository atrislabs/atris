# Headless task flow reads

Headless task checks now run two reads together; the focused test and required health checks passed, exit 0.

- files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt.
- change: JSON desk and next inspect the same open task concurrently before setup claims it. Every assertion and all 22 real CLI launches remain.
- metric: eleven sequential CLI stages become ten. Focused local sample: 1369.462375ms before, 1259.611333ms after; these samples do not establish a stable timing gain.
- focused command: `node --test --test-name-pattern='^task headless JSON contract supports create, claim, note, finish, and events$' test/commands.test.js`
- focused output: `✔ task headless JSON contract supports create, claim, note, finish, and events (1259.611333ms)`; tests 1, pass 1, fail 0, duration_ms 1397.429333, exit 0.
- frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
- frozen output: tests 35, pass 35, fail 0, duration_ms 14079.581791, exit 0.
- other commands: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json; atris task list --status open; atris task current; task new/claim/note/ready; git status --short; git diff --check (exit 0); git commit; git push.
- setup notes: brain activation and `atris brain compile --root .` returned plan-only exit 2. Missing compiled brain files were not created. No mission settings changed.
- learned: both JSON reads can share the same open state before ownership changes; the existing final event list guards against accidental writes.
- next_push: inspect the following multi-worker task test for setup-only CLI launches that can use the production store.
- unrelated edits: task database, landing proof test, rendered TODO and earlier member log additions remain unstaged.

layer: capabilities
