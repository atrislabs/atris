# Mission git wrapper dominates slow test time

Under a mission run, the first `git` on the path is a wrapper written by `lib/mission-protected-lane.js:238`. It is a Node script, so each git call starts Node and loads the guard module before handing off to real git, even though it only inspects `commit`.

Measured on this machine:
- one `git rev-parse --verify HEAD` through the wrapper: about 85ms; the real binary: about 4ms.
- one member run with one fake tick made 49 git calls, about 4.6s of a 7.0s run.
- the slowest test in `test/commands.test.js` took 6119ms with the wrapper and 1677ms with the wrapper removed from the path.
- the full file: 437 tests, all passing, 3m52s with the wrapper; 2m25s without it.
- 49 tests take over one second each and add up to 124s of the 232s total test time. Most of them create Git repositories or worktrees.

What this means: the help-batching ticks saved about 90ms per launch, real but small. Under mission runs the wrapper costs about 80ms on every git call, in the tests and in the CLI they launch. A plain `npm test` or CI run never sees it.

Not changed: the wrapper enforces which commits a mission may land, so this tick did not edit it or route tests around it. The proposed change is filed as a decision card in `atris/status/for-you.md`.

Proof:
- `node --test --test-name-pattern='^member run chooses useful work from params' test/commands.test.js` with and without the wrapper directory on the path: both pass, 6119ms and 1677ms.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

next_push: while the card waits, cut git launches from the slowest Git-heavy tests by sharing one prepared repository; if the card is approved, make the wrapper a short shell script that runs the Node guard only for commits, with a test that a blocked commit still exits 78.
layer: beliefs
