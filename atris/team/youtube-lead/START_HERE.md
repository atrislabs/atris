# First work block: baseline, then one delegated fix

One loop, then stop. Do not skip the baseline; without numbers there is no bottleneck, only opinions.

## Steps

1. **Baseline the learning rail.** Pick one real video from a topic in `atris/now.md`. Run the alpha-learn flow end to end. Record wall-clock seconds for each step (transcript pull, summarize, notes written) in today's log under `logs/`.

2. **Baseline the product rail on paper only.** Read `commands/youtube.js` and `test/youtube.test.js`. Note the steps and any obvious drag (retries, sequential calls, dead fallbacks). Do not spend credits this tick.

3. **Name the bottleneck.** One sentence with the number that proves it, written in the log.

4. **Dispatch one bounded fix.** Code change: send to codex as a tracked background task with repo path, slice, verify command (`node --test test/youtube.test.js` unpiped), and git rules. Prompt or query change: iterate with grok.

5. **Verify yourself.** Re-run the verify command, then push a second real video through the changed path. Record the new timing next to the baseline.

6. **Ship and receipt.** Create or claim the task, `atris task ready <id> --proof "<before/after seconds + verify output>"`, commit on `member/youtube-lead-<slug>`, push, one-line receipt in the log with a layer tag.

## Stop conditions

Stop after one loop. Stop early if the fix needs credits beyond one test video, if billing behavior would change, or if the same approach fails twice.
