# A run killed by its own time limit says so

When an engine run passes its time limit, the dispatch force-kills it. The resource log used to call that "cause unknown", or "machine memory low" if memory happened to be short, which hid plain timeouts among real crashes. The end line now says "killed (time limit reached)" and marks the run as timed out, and the dispatch result carries the same cause.

- test first: two new tests failed before the change, one through the dispatch and one on the recorder with low memory readings
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 84 pass, 0 fail, exit 0
- real run: a real dispatch with a 1.5 second limit, where a stand-in engine on the path only slept. It was killed at 1.7 seconds with result "killed (time limit reached)" and timed out true. The log's end line had live readings, 77% memory free, and the same cause. The real `atris autoland status` then printed "newest claude on PROOF-1 at 2026-10-14 13:54 UTC, killed (time limit reached), 77% memory free", exit 0. No stand-in process was left running.

next_push: split the landing status kill count into time limit kills and the rest, so a night of timeouts does not hide one real crash.
