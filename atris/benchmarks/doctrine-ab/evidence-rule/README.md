# the "not evidence" rule, blind a/b

The rule: the `Accuracy.` line in `atris.md` now names what is not evidence (a test piped into `tail` or `grep` so its exit code is lost, a mock in place of the real runtime, "should work", grading your own work, a test count with no repro that failed first, a summary of a file you did not open) and what is (a real run end to end, a repro that failed and now passes, before and after numbers, a transcript of the real run).

Result: same pass rate, and agents hid their test exit codes behind a pipe far less often.

## setup

- Control: the CLI at `55952f79c` (origin/master on 2026-10-26). Treatment: the same files with only `atris.md` and `atris/atris.md` changed.
- A coin flip named the arms `p` and `q` (`key.json`), so folder names, labels, and prompts never said which arm a run was in. The agent saw only the doctrine its project was set up with.
- 12 agents-v1 tasks (02 06 08 09 11 12 15 16 19 26 27 28), run through `atris member run` (Claude Opus 5.5 on the subscription login) by `scripts/member-lab.js`, scored by each task's own `check.js`.
- 4 rounds, arms alternating p,q then q,p to cancel drift: 48 runs per arm, 96 total. 48 per arm finds a change of about 30 points in a yes or no behavior 8 times in 10 at the usual 5 percent bar; the count was fixed before the first run and not extended.
- Behavior came from each run's Claude transcript (`scripts/member-lab-evidence.js`). Final reports were graded by codex (GPT, a different model family) in shuffled batches with random ids and no arm or label.
- p values are two-sided Fisher exact.

## numbers

| measure | control | treatment | p |
|---|---|---|---|
| task passed | 40/48 | 40/48 | 1.0 |
| ran a test through a pipe that drops its exit code | 41/48 | 16/48 | < 0.0001 |
| piped test commands, total | 62 | 20 | |
| final check before the report was piped | 12/48 | 7/48 | 0.31 |
| edited code after the last real run | 3/48 | 4/48 | 1.0 |
| reproduced the problem before the first edit | 35/48 | 37/48 | 0.81 |
| judge: report cites a real run | 48/48 | 48/48 | 1.0 |
| judge: report cites fail then pass | 41/48 | 44/48 | 0.52 |
| judge: report claims a check the commands do not show | 24/48 | 17/48 | 0.22 |
| average seconds per run | 124 | 127 | |

The pipe drop held task by task: treatment was lower on 11 of the 12 tasks and equal on the twelfth (task 02, where no arm piped). Tasks 16 and 28 failed in every run of both arms, so the pass tie is 40 of the 40 runs that could pass.

What did not move: reports already cited real runs in both arms, and the drop in unbacked claims (24 to 17) is the right direction but inside noise at this size.

The pipe measure matches words in the rule itself, so it shows the agents followed the rule, not that their work got more correct. The pass rate is the check on that, and it tied.

## files

- `runs.jsonl`: one row per run with arm, task, pass, and every measure above.
- `summary.json`: the table above as counts and p values.
- `key.json`: which letter was which arm.

## reproduce

From a checkout of the commit that added this folder, with the claude and codex CLIs logged in:

```
node scripts/doctrine-ab.js --lab /tmp/doctrine-ab-$(date +%s) --control 55952f79c --rounds 4 --jobs 3
```
