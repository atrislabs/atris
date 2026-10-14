# Landing status keeps timeouts from hiding a crash

The landing status kill line now counts the last day's time limit kills apart from the rest. When some kills were not timeouts, it names the newest of those instead of the newest kill overall, so a run of timeouts after a crash still points at the crash. When every kill was a timeout, it says so in plain words.

- test first: the new test failed because the line lumped two timeouts in with "0 with machine memory low"
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 85 pass, 0 fail, exit 0
- real run in a scratch project with three real dispatches: a stand-in engine that SIGKILLed itself, then two stand-ins that slept past a 1.5 second limit. The real `atris autoland status` printed "engine runs force-killed in the last day: 3, 2 at their time limit, 0 with machine memory low; newest not at a time limit: claude on CRASH at 2026-10-14 14:01 UTC, killed (cause unknown), 76% memory free", exit 0

next_push: have the sweep readout split time limit kills from the rest the same way, so both views agree.
