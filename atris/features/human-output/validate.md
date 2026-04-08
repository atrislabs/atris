# human-output — end-to-end validate

**Task:** T21
**Run date:** 2026-04-08
**Repo:** atris-cli (this workspace)

Checks per surface:
1. ≤ 20 lines
2. ≤ 80 chars wide
3. plain language (no box art in default mode)
4. non-technical reader can decide approve / hold

## Surfaces under test

| # | Surface | Capture command | Expected shape ref |
|---|---|---|---|
| 1 | autopilot tick | `node bin/atris.js autopilot --auto --iterations=1 --dry-run` | `examples.md` happy-tick / idle-tick |
| 2 | status (default) | `node -e "require('./commands/status').statusAtris(false,false,false)"` | chief-of-staff "where / queued / blocking" |
| 3 | review (validator) | `node bin/atris.js review` | `examples.md` validator-pass |

Note on status: `atris status` is currently hijacked by `.atris/business.json` into `businessStatus('pallet')`, which dumps the full Pallet diff (333 lines, not in scope for human-output). Captured `statusAtris` directly to hit the T18 surface.

## Surface: autopilot tick

Command: `node bin/atris.js autopilot --auto --iterations=1 --dry-run`

```text
  3:16 pm
  I am starting an autopilot tick in autonomous mode.
  The current limit is 1 task.

  We are working on loop-self-seeds-horizons: When `atris/TODO.md` has zero
  `[endgame]` tasks AND no inbox items AND no reactive signals, the
  autopilot loop reads recent commits + `wiki/STATUS.md` + `lessons.md` +
  the idle-tick history, asks the LLM to propose 3 candidate horizons with
  confidence scores, picks the highest, writes it to `## Endgame` + tagged
  backlog, and the next tick executes the first step. End state: the loop
  never silently idles for more than one tick — it always either has work or
  has just imagined some.
  No tagged endgame steps are queued right now.
  Identity: This defines how Atris agents communicate, decide, and work.

  Next I will scan the workspace and choose one task.


  I picked task 1 of 1.
  Validate human-output end-to-end — run one full plan→do→review cycle,
  screenshot/capture each surface, confirm ≤20 lines × ≤80 chars and that a
  non-technical reader can decide approve/hold. Append verdict to
  `atris/features/human-output/validate.md`. Exit: validate.md exists with
  pass/fail per surface.

  Why now: Next in the backlog (explore). 11 tasks waiting.

  Next: approve it, skip it, or stop the loop.


  This was a dry run, so I did not execute the task.

  Next I will look for another task on the next pass.


  Autopilot finished.
  It completed 0 tasks in 0s.
```

Measurements: 39 lines total, max line width 80 chars.

| Check | Result | Notes |
|---|---|---|
| (i) ≤ 20 lines | **FAIL** | 39 lines across banner + pick + dry-run + done blocks. Each sub-block is ≤ ~14 lines, but the full tick output as a reader sees it exceeds 20. |
| (ii) ≤ 80 chars wide | **PASS** | Max 80 chars. |
| (iii) plain language (no box art in default mode) | **PASS** | No `┌─┐ │ └─┘`, no `━━━`. |
| (iv) non-technical reader can name horizon + next step | **PASS** | Horizon slug, plain horizon text, next move (scan+pick), and decision line ("approve it, skip it, or stop the loop") all readable. |

Surface verdict: **FAIL** — only on line budget. The horizon paragraph alone is 9 wrapped lines, which eats most of the 20-line budget before the pick + dry-run + done blocks print. Fix = shrink horizon rendering (1–2 sentences) or print it only once per boundary, not every tick.

## Surface: status (default)

Command: `node -e "require('./commands/status').statusAtris(false,false,false)"`

```text
  Where we are:
  The active horizon is loop-self-seeds-horizons. When `atris/TODO.md` has
  zero `[endgame]` tasks AND no inbox items AND no reactive signals, the
  autopilot loop reads recent commits + `wiki/STATUS.md` + `lessons.md` +
  the idle-tick history, asks the LLM to propose 3 candidate horizons with
  confidence scores, picks the highest, writes it to `## Endgame` + tagged
  backlog, and the next tick executes the first step. End state: the loop
  never silently idles for more than one tick — it always either has work or
  has just imagined some. There are 0 tasks in progress, 11 queued, and 56
  completed items still sitting in TODO.

  What is queued:
  Next backlog item: Validate human-output end-to-end — run one full
  plan→do→review cycle, screenshot/capture each surface, confirm ≤20 lines ×
  ≤80 chars and that a non-technical reader can decide approve/hold. Append
  verdict to `atris/features/human-output/validate.md`. Exit: validate.md
  exists with pass/fail per surface.. Inbox has 4 items.

  What is blocking:
  Main drag: 56 completed items should be cleared from TODO. No team
  activity is logged yet today.
```

Measurements: 22 content lines, max line width 83 chars.

| Check | Result | Notes |
|---|---|---|
| (i) ≤ 20 lines | **FAIL** | 22 lines. The horizon paragraph in "Where we are" is doing the overrun again. |
| (ii) ≤ 80 chars wide | **FAIL** | Max 83 chars — wrapper is set to 74 inner chars but the 2-space indent + tail punctuation pushes a few lines to 83. |
| (iii) "where we are / queued / blocking" sections present | **PASS** | All three sections render. |
| (iv) non-technical approve-or-hold decidable | **PARTIAL** | Reader can tell what's queued + what's blocking, but there is no explicit "Decision:" line like the examples. |

Surface verdict: **FAIL** — 2 chars over width, 2 lines over budget, and the decision line is implicit. Fix = tighten wrap width to ~78, summarize horizon in one sentence, add a trailing "Decision: …" line.

Routing side note: `atris status` (no sub-command) reads `.atris/business.json` and dispatches to `businessStatus('pallet')`, which prints a 333-line diff dump. Out of scope for human-output surface audit (not in T15 table), but worth flagging — it means a real operator running `atris status` in this repo today never sees the chief-of-staff output, they see the Pallet file list.

`atris status --verbose` reference capture was **not taken** — in this repo the sub-command branch fires before `--verbose` is parsed, so `--verbose` is ignored. Same routing bug.

## Surface: review (validator)

Command: `node bin/atris.js review`

```text
atris review — validator.
i checked the workspace. map is present, todo is present, 10 feature validate scripts queued.
next i'll run tests, walk each validate.md, and clean completed tasks out of todo.md.
(run `atris review --verbose` for the full prompt + appendix.)

next: `atris do` to fix issues, then `atris review` again.
```

Measurements: 6 content lines (8 incl. trailing blank), max line width 93 chars.

| Check | Result | Notes |
|---|---|---|
| (i) ≤ 20 lines | **PASS** | 6 lines. |
| (ii) ≤ 80 chars wide | **FAIL** | Line 2 is 93 chars, line 3 is 85. No wrap applied. |
| (iii) plain-language verdict | **PARTIAL** | Plain language, but the default mode prints a forward-looking "next i'll…" rather than a verdict against a completed change. Reads as "about to review" not "reviewed". |
| (iv) non-technical approve/hold decidable | **FAIL** | No verdict line. The reader cannot tell if there is anything to approve — the default surface is a pre-amble, not a review result. Matches the T21d "no in-progress task" condition: there is nothing in `## In Progress` for review to verdict on, so the command is showing its "about to start" banner. |

Surface verdict: **FAIL** — width overrun on 2 lines, and the default non-`--verbose` review surface does not produce a chief-of-staff verdict block at all. Closest `examples.md` shape ("Validator pass") is not emitted today. This surface still needs the T19 rewrite for review-phase output.

## Verdict

| Surface | Pass/Fail | Notes |
|---|---|---|
| autopilot tick | **FAIL** | 80-char width OK; 39-line budget blown by horizon paragraph + multi-block tick layout. |
| status (default) | **FAIL** | 22 lines (2 over), 83 chars (3 over), no explicit decision line. Also gated by `.atris/business.json` routing in this repo. |
| review | **FAIL** | 93-char line, no verdict block — default surface is a pre-run banner, not a chief-of-staff review. Needs T19 rewrite. |

**Overall: FAIL.** Every in-scope surface misses at least one of the four checks. The closest to green is status (sections present, only cosmetic width + budget misses). The farthest from green is review (no verdict block in default mode).

Top fixes, in priority order:
1. review surface — emit a 3-paragraph validator-pass block per `examples.md`, wrap to ≤ 80 chars, include an explicit "Decision:" line. (T19 scope.)
2. autopilot tick — render horizon in ≤ 2 sentences per tick so the budget holds at ≤ 20 lines across banner + pick + done. Cache full horizon text for boundary ticks only.
3. status — tighten wrap width to 78, collapse horizon to one sentence, append explicit "Decision: …" line.
4. status routing — either make `atris status` prefer `statusAtris` and require an explicit `atris status <biz>` for businessStatus, or have businessStatus also honor the chief-of-staff shape.

History:
- T15 — surface audit in `idea.md`
- T16 — `examples.md` target shapes (2026-04-08)
- T17 — autopilot tick rewrite (2026-04-08)
- T18 — status chief-of-staff rewrite (2026-04-08)
- T20 — heartbeat tick summary into journal Notes (2026-04-08)
- T21 — this validate pass (2026-04-08)
