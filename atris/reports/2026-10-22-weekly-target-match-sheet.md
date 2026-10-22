# Weekly target match sheet, week of 2026-10-19

The board says 0 of 19 landed. The count is right about this week, and wrong about the work.

Read on 2026-10-22 from the job list (`~/.atris/tasks.db`), the autoland list, GitHub, and `git log origin/master`.

## What the numbers really are

- 19 is not a list of 19 jobs. It is the suggested weekly number: the last four weeks' landings averaged, rounded up. Those weeks had 0, 0, 0 and 75 landings, so 75 / 4 = 18.75, rounded to 19.
- The 75 all landed on one day, 2026-10-15, in one sweep. Before that week, no job here ever counted as landed.
- 160 is last week's finished jobs across every project (Oct 12 to 18), not this week's merges.
- This week (since Monday) master took 25 merges. None of them names a job, and no job was finished anywhere: the last finished job in any project was 2026-10-16.
- This week's merges are the new tidy-up command (zen, 18 merges), the game board (4), help (1) and campaign checks (1). Nobody filed a job for any of it, so none of it can count.

## The 26 jobs still waiting here, paired with their change

Paired by the member's branch name plus the minute the job was taken (the branch carries that timestamp). The autoland list agrees on the one pair it records.

### Change merged to master, job still waiting (9)

Each merge was checked as part of origin/master with base master.

| job | member | merged change | merged |
|---|---|---|---|
| 01M4YMY4PD | codex-executor | #1259 Fast check passes inside member runs | 10-15 |
| 01M4YNAZDJ | codex-executor | #1277 Reviews stop timing out | 10-15 |
| 01M4YP603G | generalist | #1270 A member's job closes itself when its own change merges | 10-15 |
| 01M4YPC7EX | executor | #1271 A retry starts fresh when the last branch conflicts | 10-15 |
| 01M4YRGJ7X | builder | #1280 A planned job is only asked for the parts it is missing | 10-15 |
| 01M4Z2Y7DM | builder | #1306 A fix counts against a landing only when it changes its lines | 10-15 |
| 01M4Z4448W | executor | #1314 Slow-machine test runs no longer time out mid-mission | 10-15 |
| 01M4Z4YVHB | builder | #1319 A clashing member change closes itself once its redo merges | 10-15 |
| 01M4Z516ME | auto-improver | #1318 next step toward detector-backed fixes | 10-15 |

The third row is the feature that should have closed all nine. Its own job never closed either.

### Change still open, not merged (9)

| job | member | open change |
|---|---|---|
| 01M4YMY3SG | builder | #1263 |
| 01M4YNEKHG | executor | #1266 |
| 01M4YNQ6N1 | generalist | #1268 |
| 01M4YNV15V | builder | #1274 |
| 01M4Z21TZZ | codex-executor | #1296 |
| 01M4Z2JWTC | builder | #1302 |
| 01M4Z2Y7DZ | executor | #1311 |
| 01M4Z342ZQ | auto-improver | #1307 |
| 01M4Z3KCNM | auto-improver | #1309 |

### Change closed without merging (1)

| job | member | closed change |
|---|---|---|
| 01M4YNM4QA | auto-improver | #1265 |

### No change found (7)

| job | member | title |
|---|---|---|
| 01M4X9PPFQ | architect | Wake skips jobs tagged needs-human or decision |
| 01M4X9PQAC | builder | Waking members with no jobs says how to add one |
| 01M4XAEFX1 | architect | Member runs check repo tidiness before they finish |
| 01M4YD6KJH | nobody | The approving model checks every part of done-looks-like |
| 01M4YMQ3NP | nobody | The team briefing tells the truth |
| 01M4YPH1XF | nobody | The member file's shared helpers move to their own file |
| 01M4YR3FG6 | nobody | next step: improve the system without hidden risk |

## Two causes, for step two to trace

One. Merged member changes never flip their job to landed. Nine jobs prove it, including the job for the fix meant to do exactly that.

Two. This week's work never went through the job list at all. The tidy-up and game merges came from runs that file no job, so the board has nothing to count.

## What the owner decides (step four, not done)

If the owner says yes to the nine merged rows, this week shows 9 of 19, past the goal of 6. Marking them now would credit this week for work merged last week, so that call is the owner's, row by row. The other 17 stay open.
