# Engine sweep shows runs with no end

The sweep command now says how many engine runs started and never recorded an end, and names the newest one. A run that died along with its parent used to leave no trace in the readout.

- test first: the new test failed (open run count was missing) before the change
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 75 pass, 0 fail, exit 0
- real run, in a scratch project with one finished run and one run with no end, `atris engine sweep` exited 0 and printed:
  `1 run started with no end recorded (still running, or stopped with their parent); newest: cursor on PROOF-2 at 2026-10-14 13:07 UTC`
- the same run listed 194 ssh-agents on this machine, 159 of them leaked; nothing was stopped

next_push: start a run's end line from the parent when the child is gone, so open runs can be closed with an honest "parent gone" cause.
