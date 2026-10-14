# Growth note counts from the last sweep that stopped agents

A sweep that stops leaked ssh-agents now writes how many still looked leaked once it was done. The growth note in the landing status and the sweep then counts from the newest sweep that stopped agents, and says so, instead of from a count taken before the pile was cleared. Before this, a refill right after a sweep read as slower than it was, or not at all.

- test first: two tests failed, one because the sweep line had no count, one because the note still counted from the older run start
- verifier: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, 90 pass, 0 fail, exit 0
- real run on this machine, read only, nothing stopped: a scratch log held the 213 count from 13:25 UTC and a sweep line from an hour earlier that stopped agents and left 5
  - `atris engine sweep`: "424 ssh-agents running, 390 look leaked, up from 5 left by the sweep at 2026-10-14 13:31 UTC, about 385 more an hour (...)", exit 0
  - `atris autoland status`: "leaked ssh-agents on this machine: 390, up from 5 left by the sweep at 2026-10-14 13:31 UTC, about 385 more an hour; stop them now: atris engine sweep --apply", exit 0
  - the sweep line was seeded, so the rate is not a real measurement; the line a real sweep writes is covered by the sweep test, since running one here would stop the machine's real agents
- map: refs below the changed lines shifted and checked against the code they name

next_push: run one real sweep with stopping on this machine once the operator agrees, then confirm the next status counts from what it left.
