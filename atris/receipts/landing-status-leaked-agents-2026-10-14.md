# Landing status counts leaked ssh-agents

The landing status now reads the machine once and prints how many ssh-agents look leaked right now, with how they get stopped: the next hourly pass when the heartbeat is live, otherwise the sweep with apply. It only reads; nothing is stopped. With none leaked, or a failed read, the line stays out, and a test run never reads the real machine.

- test first: the new test failed because the status could not take a stand-in reader
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 87 pass, 0 fail, exit 0
- real run on this machine in a scratch project, read only: the real `atris autoland status` printed "leaked ssh-agents on this machine: 348; stop them now: atris engine sweep --apply", exit 0, under a second. The real `atris engine sweep` agreed: "383 ssh-agents running, 348 look leaked", exit 0.
- seen: 348 leaked at 14:16 UTC, up from 213 at 13:25, about 160 an hour
- map: several landing pass refs had drifted in earlier ticks; each now points at the code it names, checked line by line

next_push: show how fast leaked ssh-agents are growing in the landing status, from the counts each engine run start already records, so a leak that is filling the machine reads as urgent.
