
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

## Quick command checks pass inside a mission
- shipped: The quick command checks now ignore the enclosing mission engine setting while keeping their original assertions.
- proof: `node --test test/smoke.fast.test.js test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, 37 passed, zero failed.
- reply: keep / revert

## Isolated command tests keep their own Git setup
- shipped: Command fixtures now avoid enclosing mission Git wrappers, preventing a confirmed false build failure.
- proof: /opt/homebrew/bin/node --test --test-name-pattern='a real isolated review on main' test/one-lap-runtime.test.js, exit 0; frozen checks, exit 0, 35 passed.
- reply: keep / revert

## Duplicate requests prove they overlap
- shipped: the duplicate-request check uses a release signal and requires the second request to wait, reducing timing sensitivity and removing five seconds of fixed delay.
- proof: /opt/homebrew/bin/node --test --test-name-pattern=identical test/one-lap-runtime.test.js, exit 0; frozen checks, 35 passed, exit 0.
- reply: keep / revert
