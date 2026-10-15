# Unfinished runs say whether their parent is gone

Each run start now records which process will write its end. The sweep checks that process and splits unfinished runs into ones whose parent is gone, ones still running, and older ones from before parents were recorded.

- test first: the new test and the updated sweep wording failed before the change
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 77 pass, 0 fail, exit 0
- real run: two real processes each recorded a start; one got SIGKILL before writing its end, one stayed alive. `atris engine sweep` exited 0 and printed:
  `2 runs started with no end recorded: 1 whose parent is gone, 1 still running; newest: cursor on LIVE-PARENT at 2026-10-14 13:15 UTC`
- limit: a reused process id reads as alive, so a lost run can be undercounted, never invented

next_push: let atris engine sweep --apply write an end line for each run whose parent is gone, with cause "parent gone", so the log stops carrying them as open.
