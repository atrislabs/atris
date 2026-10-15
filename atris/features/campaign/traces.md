# Campaign traces

A campaign already has the shape of a learning episode. The state is the folded view. Each action is a mission. The reward comes from the judge, a command the agents do not control. The cost is the dollars each mission spent.

`atris campaign export <id> --trace` writes that episode as JSON lines: one header, then one row per mission that ended.

```text
atris campaign export cmp-stats --trace                  redacted JSONL on stdout
atris campaign export cmp-stats --trace --out t.jsonl    to a file
atris campaign export cmp-stats --trace --full           your own data, with the words
```

Code: `lib/campaign-trace.js` (pure, deterministic) and `lib/campaign-reading.js` (judge readings). Tests: `test/campaign-trace.test.js`, `test/campaign-reading.test.js`.

## The judge reading

Every judge run now stores a `reading` from 0 to 1 when its output has counts, so the campaign learns "3 of 5 pass" and not only "failed". The reading comes from the first of these that the output has:

- a line `reading: 0.6` (a judge that scores itself)
- a final line like `3 of 5 live` or `2/8 pages render`
- node test counts (`ℹ pass 3`, `ℹ fail 2`), summed when the judge chains runs
- jest or vitest `Tests:` lines, pytest `2 failed, 3 passed`, mocha `4 passing`

Skipped tests are left out. Output with no counts stores no reading; a number is never made up.

Each judge run also stores `output_tail`, the last 40 lines of output (at most 4 KB). The planner reads it, fenced, so it sees why the judge failed and not only the last line.

## A row

```json
{"kind":"step","campaign_id":"cmp-dd98c498a0af","step":1,"at":"2026-10-15T10:12:04.151Z",
 "batch":{"index":1,"size":2},
 "state_before":{"state":"resting","reading":0,"confidence":"open","judge_runs":1,
   "budget":{"total":4,"spent":0,"reserved":0,"available":4},
   "missions":{"proposed":0,"claimed":0,"running":0,"ended":0,"vetoed":0,"dropped":0},"open_asks":0},
 "action":{"mission_id":"m-7d0760eeb44a","kind":"mission","member":"builder","engine":null,"estimate_usd":0.75},
 "outcome":"kept","cost_usd":0.27,"ticks":2,"uncosted_ticks":1,"human_asks":0,
 "reading_before":0,"reading_after":1,"reading_source":"pass_fail","reward":0.5,
 "credit_note":"one of 2 missions that ended between the same two judge runs; the reading change is split equally",
 "done":true,"judge_passed":true}
```

- `state_before` is the campaign view just before the mission's first event: state, last reading, confidence, money, and mission counts.
- `action` is who did what. `kind` is `plan` for a planning call that produced nothing. `engine` is filled when the log names it.
- `cost_usd` is what the mission reported. `uncosted_ticks` counts ticks whose engine gave no dollar figure, so a reader knows the cost is a floor.
- `human_asks` counts the times this mission stopped for a person.
- `done` is true once the campaign has finished at or before the judge run that scored this row.
- `judge_passed` is whether that judge run passed.

The header row gives the schema name and version, the judge's runner (for example `node`), the reward rule, the privacy policy, and the final state, reading, and money.

## How reward is computed

Missions are grouped by the judge runs on either side of where they ended. Missions that ended between the same two runs form a batch.

```text
reward = (reading_after - reading_before) / batch size
```

`reading_before` is the last judge run before the mission ended, `reading_after` is the first one after. A reading is the stored graded number, else the counts in the stored summary, else 1 for a pass and 0 for a fail (`reading_source` says which). A mission with no judge run after it yet has `reward: null` and a `credit_note` saying why.

Splitting a batch equally is honest about what we know: the judge saw the batch land together, not each mission alone. A campaign that wants sharper credit runs the judge after each mission (the loop does this when missions run one at a time).

## The Goodhart guard

When a score becomes the target, agents learn to move the score instead of the work. Three rules keep the reward worth learning from:

1. The judge is a command outside the model. Agents cannot write a `judge_ran` event by hand; only `atris campaign judge` and the loop record one, and both run the real command.
2. Prefer held-out judges. A judge whose tests the agents never read is the reading a lab can trust. A judge the agents can edit is a reading of their own work, so treat it as weaker.
3. Read the review too. A mission can raise the reading by weakening a test. The review desk checks missions against the Standard, and an outcome of `reverted` or `failed` stays in the row next to the reward.

## Privacy

Redaction is on by default. A redacted trace drops titles, objectives, verify commands, the judge command, judge summaries and output, and ask questions and answers. Campaign and mission ids become stable pseudonyms, because Atris ids carry words from the title. People show as `human`. Members, engines, numbers, outcomes, and timing stay.

`--full` keeps the words. Use it for your own data, or with the written consent of everyone who worked in the campaign. Nothing is sent anywhere: export writes a file or stdout, and sharing it is a separate choice the owner makes.

## Why labs want this

Most agent data is one person, one model, one short task, with a reward a model guessed. Campaign traces differ on four counts:

- **Multiplayer.** Several members work the same goal at once, and people step in through asks. The rows show who did what, side by side.
- **Long horizon.** A campaign runs for hours or weeks across many missions, so credit has to travel across steps. That is the hard part labs need data for.
- **Real cost.** Every row carries dollars spent, so a policy can learn progress per dollar and not progress at any price.
- **Outside reward.** The reward is a command's result, not a model's opinion, and the export says which judge produced it.
