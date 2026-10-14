# Mission git guard cost on the landing tests

Picked the auto-landing test file, the second slowest in the first timing pass of every file.

## Per-test profile

Logged every child process for one test ("tick still lands an ordinary command proof with exit 0"). The four setup launches took about 0.6s. The landing tick took 3.0s, of which 0.7s was its inner certify pass and the rest was about 100 git calls.

Every git call appeared twice: a 5ms real git call wrapped inside a 40 to 50ms Node process. The wrapper is the mission git guard written by `lib/mission-protected-lane.js:238`. It starts Node for every git call and only acts when the subcommand is commit.

## Whole-file timing

`node --test test/autoland.test.js` with the guard first on the search path: exit 0, pass 67, fail 0, 110.7s.

Same command with the guard directory removed from the search path, git resolving to /opt/homebrew/bin/git: exit 0, pass 67, fail 0, 31.1s.

The guard accounts for about 72% of the file's run time inside a mission session. Earlier rounds compared before and after inside the same session, so their relative savings stand, but their absolute times include this cost.

## Second risk, not reproduced

On commit, the guard inspects the staged diff of the mission root from its config, not the repo the commit runs in. A test that commits in a temporary fixture repo is checked against the mission folder. If the mission folder had a protected file staged, those fixture commits would exit 78. Not triggered in this run.

## Why no code change

The guard enforces which files a mission may commit, so changing it is a policy change. Filed as a decision card in `atris/status/for-you.md`.

Proposed fix: write the wrapper as a sh script that execs git directly unless the subcommand is commit, and run the commit check only when the commit's repo is inside the mission root.

No test file changed this round.

next_push: time the remaining slow files with the guard removed from the search path, so picks reflect real cost.
layer: beliefs
