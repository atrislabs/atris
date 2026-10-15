## Run-record test fixture setup, 2026-10-14

Run-record tests now seed the same five engine health values in one registry write. Setup reads and writes fall from six each to one each per room, across 12 rooms, with every real run and record assertion retained.

Proof: `node --test test/roster-run-record.test.js` exited 0: `tests 12`, `pass 12`, `fail 0`. A side probe built the registry both ways in scratch folders and compared them after load: the only differences were check-time stamps on two engines the fixture never touches (opencode, commandcode), plus the top-level update time.

Timing: one sample each, 23959.663834ms before and 23864.704166ms after. That is within noise, so this is an I/O cut, not a measured speedup.

Files: test/roster-run-record.test.js, atris/refs/MAP-NOTES.md, atris/receipts/2026-10-14-run-record-fixture-health.md, atris/team/auto-improver/logs/2026-10-14.md.

Lesson: the repeated health writes were cheap next to the real runs in this file; the remaining time is in the engine launches themselves.

next_push: profile the slowest run-record case and see whether a setup-only launch inside it can use a direct store call.
layer: capabilities
