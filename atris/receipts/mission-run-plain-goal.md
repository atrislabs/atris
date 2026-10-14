# Plain mission goals now start the work

A plain terminal mission run now starts its worker and checks the result. The frozen check passed with exit 0, five cases passed and zero failed.

## Change and plan

objective -> save goal -> bounded worker loop -> stored check -> receipt
live Codex or manual -> existing handoff

Files edited: commands/mission.js, test/mission-run-plain-goal.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, this receipt, and the ignored member log atris/team/architect/logs/2026-10-14.md.

Proceed: reuse the existing runner selection and execution loop. The main risk is launching a second worker around a live session; explicit native, live native, and manual cases prove the handoff stays intact. No dependencies or mission contracts changed.

## Rerunnable verification

`node --test test/mission-run-plain-goal.test.js`

Exit: 0. Exact summary: tests 5; suites 0; pass 5; fail 0; cancelled 0; skipped 0; todo 0.

Related check: `node --test test/mission-run-default-runner.test.js test/default-runner.test.js`, exit 0; tests 3; pass 3; fail 0.

## Real command evidence

Run from /tmp/atris-plain-goal-proof:

```sh
ATRIS_CALLER_RUNTIME=terminal ATRIS_SKIP_UPDATE_CHECK=1 PATH=/tmp/atris-plain-goal-proof/bin:/opt/homebrew/bin:/usr/bin:/bin node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-a-plain-mission-run-with-a-goal-actu-20261014-125954/bin/atris.js mission run 'write the requested result file' --owner architect --no-preflight --max-ticks 1 --max-wall 20 --no-drain --verify 'test -s result.txt' --complete-on-pass --json > result.json
```

Exit: 0. The real CLI launched a deterministic local worker executable, rather than a paid model; the worker created result.txt. This proves routing and execution, not model quality.

Output excerpt from result.json:

```json
{"action":"mission_run","runner":"claude","status":"complete","ran_ticks":1,"verifier_passed":true}
```

result.txt output: `the work happened`

Artifacts: /tmp/atris-plain-goal-proof/result.txt, /tmp/atris-plain-goal-proof/result.json, and the CLI-generated receipt under /tmp/atris-plain-goal-proof/atris/runs/.

State inspected: original mission is planning, no human asks, frozen check unchanged. Its parent process holds the mission lock, so attaching a task was refused; a separate local task records this same bounded change. The compiled context commands returned exit 2 with a plan-only response; generated adapters were left alone.

Metric: the objective now produces one checked work step instead of only a start record; all five regression cases pass.

next_push: Make a failed mission check return a failing terminal exit code consistently.
layer: behaviors
