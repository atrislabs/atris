# Landing status names force-killed runs and their cause

The landing status now prints one line when an engine run was force-killed in the last day: how many, how many had machine memory low, and the newest one with its engine, task, time, cause, and free memory. With no kill in the last day, the line stays out. Before this, only the sweep showed kills.

- test first: the new test failed because the readout had no kill line
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 82 pass, 0 fail, exit 0
- real run in a scratch project: a real child process got SIGKILL and its end was recorded with live machine readings, then the real `atris autoland status` printed "engine runs force-killed in the last day: 1, 0 with machine memory low; newest claude on PROOF at 2026-10-14 13:46 UTC, killed (cause unknown), 76% memory free", exit 0
- wording: the first draft said "killed by the system", but the proof kill came from a parent, so the line now says "force-killed"

next_push: record which process sent the kill when it can be known, starting with the run's own timeout, so a timeout kill stops reading as cause unknown.
