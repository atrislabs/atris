# the "not evidence" rule, blind a/b

The rule: the `Accuracy.` line in `atris.md` now names what is not evidence (a test piped into `tail` or `grep` so its exit code is lost, a mock in place of the real runtime, "should work", grading your own work, a test count with no repro that failed first, a summary of a file you did not open) and what is (a real run end to end, a repro that failed and now passes, before and after numbers, a transcript of the real run).

Result: same pass rate, agents hid test exit codes behind a pipe half as often, and their final reports stopped claiming checks they never ran.

## setup

- Control: the CLI at `55952f79c` (origin/master on 2026-10-26). Treatment: the same files with only `atris.md` and `atris/atris.md` changed.
- A coin flip named the arms `p` and `q` (the `key` in the summary file), so folder names, labels, and prompts never said which arm a run was in. The agent saw only the doctrine its project was set up with.
- 12 agents-v1 tasks (02 06 08 09 11 12 15 16 19 26 27 28), run through `atris member run` (Claude Opus 5.5 on the subscription login) by `scripts/member-lab.js`, scored by each task's own `check.js`.
- 4 rounds, arms alternating p,q then q,p to cancel drift: 48 runs per arm, 96 total. 48 per arm finds a change of about 30 points in a yes or no behavior 8 times in 10 at the usual 5 percent bar; the count was fixed before the first run and not extended.
- Behavior came from each run's Claude transcript (`scripts/member-lab-evidence.js`), read step by step: shell writes like `sed -i` count as edits, and a pipe counts as hiding the exit code unless the command sets `pipefail` or reads zsh's `pipestatus`.
- Final reports were graded by codex (GPT, a different model family) in shuffled batches of 8, with random ids, run labels scrubbed from the text, and each run's last 40 shell commands beside the report.
- p values are two-sided Fisher exact.

## numbers

| measure | control | treatment | p |
|---|---|---|---|
| task passed | 44/48 | 44/48 | 1.0 |
| ran a test through a pipe that drops its exit code | 44/48 | 21/48 | < 0.0001 |
| piped test runs, total | 92 | 26 | |
| last run before the report was piped | 12/48 | 4/48 | 0.053 |
| judge: report claims a check the commands do not show | 6/48 | 0/48 | 0.026 |
| judge: report cites fail then pass | 41/48 | 44/48 | 0.52 |
| judge: report cites a real run | 48/48 | 48/48 | 1.0 |
| reproduced the problem before the first edit | 41/48 | 43/48 | 0.76 |
| edited code after the last real run | 4/48 | 7/48 | 0.52 |
| average seconds per run | 124 | 127 | |

The pipe drop held task by task: treatment was lower on 11 of the 12 tasks and equal on task 16. Task 16 failed in every run of both arms, so the pass tie is 44 of the 44 runs that could pass.

What did not move: every report in both arms already cited a real run, and editing after the last run went 4 to 7, the wrong way but inside noise.

The pipe measure matches words in the rule itself, so on its own it shows the agents followed the rule. The unbacked-claim drop (6 to 0) is the outside check that reports got more honest, and the tied pass rate says the work did not get worse.

## how the numbers were checked

An outside codex review of the first draft found real measurement bugs: zsh's empty `PIPESTATUS` counted as kept, `sed -i` edits were missed, the judge saw commands cut to 240 characters and one run label, and member-lab dropped the env a task check passes to `ctx.run`, so task 28 failed in every run of both arms. All were fixed, every run was rescored from its saved folder and transcript, and the judge regraded all 96 reports. The agent runs themselves were not repeated. The first draft read 40 vs 40 passed, 41 vs 16 piped, and 24 vs 17 unbacked; the direction held and the table above is the corrected one.

## files

- `doctrine-ab-evidence-rule.runs.jsonl`: one row per run with arm, task, pass, and every measure above.
- `doctrine-ab-evidence-rule.summary.json`: the table above as counts and p values, plus which letter was which arm.

## reproduce

From a checkout of the commit that added these files, with the claude and codex CLIs logged in:

```
node scripts/doctrine-ab.js --lab /tmp/doctrine-ab-$(date +%s) --control 55952f79c --rounds 4 --jobs 3
```
