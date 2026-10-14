
## Decide: land the faster mission git wrapper
- what: every git call inside a mission now skips loading the commit guard unless it is a commit. Commits are checked exactly as before.
- why it needs you: the mission commit guard blocked the commit ("protected mission surface requires human review: public dynamic rendering"). The diff touches the guard's own code and its test file, whose fixtures contain the protected words.
- buys: the slow member wake test file drops from about 31s to about 23.5s under a mission, 6/6 passing both ways. Every git call an agent makes in a mission gets about 40ms cheaper.
- proof: node --test test/mission-protected-lane.test.js (20/20, exit 0); new test fails without the change; frozen verifier 35/35, exit 0.
- where: the harness reset the checkout after the held tick, so the change now lives as a patch: atris/status/mission-git-wrapper-lazy-guard.patch in worktree auto-improver-eliminate-flaky-tests-and-timing-cap-20261014-113355. Land with `git apply` on that branch, then commit.
- reply: land / drop

## Supervisor checks finish without racing machine speed
- shipped: controlled time completes every expected outcome and cuts the focused run from 20.7s to 6.7s.
- proof: node --test test/spaceship-supervisor.test.js, exit 0; frozen mission checks, exit 0.
- reply: keep / revert
