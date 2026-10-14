# Sweep keeps timeouts from hiding a crash

The sweep readout now counts SIGKILLs at their time limit beside the low memory count. When the newest kill was a timeout, it adds a line naming the newest kill that was not one. The sweep and the landing status now tell the same story.

- test first: the new test failed because no line named the crash behind two timeouts
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 86 pass, 0 fail, exit 0
- real run in a scratch project with three real dispatches: a stand-in engine that SIGKILLed itself, then two that slept past a 1.5 second limit. The real `atris engine sweep`, read only, exit 0, printed:
  - last SIGKILL: claude on SLOW2 at 2026-10-14 14:08 UTC, killed (time limit reached), 77% memory free
  - last SIGKILL not at a time limit: claude on CRASH at 2026-10-14 14:08 UTC, killed (cause unknown), 76% memory free
  - 0 of 3 SIGKILLs ended with machine memory low, 2 at their time limit

next_push: show the count of leaked ssh-agents in the landing status, so a pile like the 213 on this machine is visible without running the sweep.
