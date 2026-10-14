# Hourly landing pass closes runs lost with their parent

Each hourly landing pass now writes a "parent gone" end line for every engine run whose dispatching process died, right after it stops leaked ssh-agents. Lost runs stop piling up as open between manual sweeps, and the pass summary says how many it closed. A failed read is recorded on the pass and never breaks it.

- test first: two new tests failed with "runLostRunSweep is not a function" before the change
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 80 pass, 0 fail, exit 0
- real run in a scratch project: one parent got SIGKILL after its start line, one stayed alive. The landing pass step returned closed ["gone-1"] with note ", closed 1 lost engine run"; a second pass closed nothing. The real `atris engine sweep` then printed "1 run started with no end recorded: 1 still running", exit 0.
- seen on this machine: 213 ssh-agents look leaked at 13:25 UTC, up from 159 at 13:07. Not stopped by this tick.

next_push: show the last pass's closed lost runs in the landing status readout.
