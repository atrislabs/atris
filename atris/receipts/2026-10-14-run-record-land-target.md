## Run-record dispatches skip a repeated git lookup, 2026-10-14

The run-record dispatch helper now hands the dispatch the land target that an empty scratch room always resolves to, instead of asking git for it on every dispatch. One test still runs the real lookup and checks it gives the same answer, so drift is caught.

Profile: one dispatch took about 1.8 seconds. The land target lookup took about 0.4 seconds of that, the engine run with sandbox teardown about 0.75 seconds, the brief's base lookup about 0.33 seconds, and the machine resource probe about 0.25 seconds.

Proof: `node --test test/roster-run-record.test.js` exited 0 three times: `tests 12`, `pass 12`, `fail 0`, at 20674ms, 21071ms, and 20126ms. The committed version ran at 23772ms, 23864ms, and 23507ms (the last back to back with 20126ms).

Metric: about 3.4 seconds off a 23.5 second file, roughly 14 percent, with every dispatch and record assertion retained.

Files: test/roster-run-record.test.js, atris/refs/MAP-NOTES.md, atris/receipts/2026-10-14-run-record-land-target.md, atris/team/auto-improver/logs/2026-10-14.md.

Lesson: profile before guessing. The previous tick's write cut saved nothing measurable; a CPU profile of one dispatch pointed at git and process probes that the flight already lets a caller pass in.

next_push: check whether the brief's base lookup or the machine resource probe in a dispatch can take an injected value the same way, keeping one real-lookup assertion.
layer: capabilities
