## Fast smoke checks use their own engine
- shipped: the test supplies its own engine installation and selection, preserving all existing assertions and adding checks for the expected scope and installed state.
- proof: node --test test/smoke.fast.test.js, exit 0; git diff --check, exit 0. Full repeated-run output: atris/runs/2026-10-13-smoke-engine-isolation.md.
- reply: keep / revert

## Command checks spend less time probing database support
- shipped: Database support is checked once, preserving all command assertions and saving repeated child launches.
- proof: node --test test/commands.test.js, exit 0, pass 437 / fail 0 before and after; git diff --check, exit 0.
- reply: keep / revert

## Decision: the mission git guard makes every test about 3x slower inside mission runs
- found: inside a mission run, every git call goes through a guard that starts a whole Node process just to check whether the call is a commit. The landing test file takes 111s with it and 31s without it, all 67 passing both ways.
- proposed fix: write the guard as a small shell script that hands every non-commit call straight to git and only starts Node for commits. Commit checks stay exactly as they are.
- second risk, not yet triggered: the guard checks commits against the mission folder even when a test commits inside its own throwaway repo, so a protected file staged in the mission folder could fail unrelated tests.
- why I did not change it: it enforces which files a mission may commit, so it is a policy surface and waits on you.
- detail: atris/runs/2026-10-14-mission-git-guard-test-cost.md
- reply: build it / leave it
