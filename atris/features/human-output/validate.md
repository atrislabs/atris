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

Command: `node bin/atris.js autopilot --auto --iterations=1` (T21b re-capture,
non-dry-run, default non-verbose). The tick blocks on a `claude -p` subprocess
at the "I am running that task now" step; the stdout block below is the full
default non-verbose output emitted before that blocking call.

```text

  3:46 pm
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
  Capture autopilot tick output — run `atris autopilot --auto
  --iterations=1` from this repo, paste the full default (non-verbose)
  stdout block into `atris/features/human-output/validate.md` under `##
  Surface: autopilot tick`. Exit: section has raw block + 4 check results +
  overall pass/fail.

  Why now: This was already started by Executor at 2026-04-08T22:41:42.058Z
  but never finished.

  Next: approve it, skip it, or stop the loop.


  I am running that task now.

  Next I will report what happened and whether review passed.
```

Measurements: 36 lines total, max line width 78 chars.

| Check | Result | Notes |
|---|---|---|
| (i) ≤ 20 lines | **FAIL** | 36 lines across banner + pick + run blocks; horizon paragraph alone is 9 wrapped lines. |
| (ii) ≤ 80 chars wide | **PASS** | Max 78 chars. |
| (iii) plain language (no box art in default mode) | **PASS** | No `┌─┐ │ └─┘`, no `━━━`; all briefing copy. |
| (iv) non-technical reader can state horizon + next step | **PASS** | Horizon slug + plain horizon text printed; next step ("scan and choose one task", "approve it, skip it, or stop the loop") readable. |

Surface verdict: **FAIL** — width and plain-language checks pass, non-technical
reader can state horizon + next step, but the 20-line budget is blown (36
lines). Same root cause as T21 run: the horizon paragraph rendered in full on
every tick eats most of the budget before the pick + run blocks print. Fix =
render horizon in ≤ 2 sentences (or print the full horizon only on a boundary
tick, slug-only after that).

## Surface: status

Note: `atris status` with no sub-command is hijacked in this repo by
`.atris/business.json` → `businessStatus('pallet')`, and the `--verbose`
flag is swallowed by the same branch before parsing. To hit the T18
chief-of-staff surface we invoke `statusAtris` directly.

### Default mode

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
  has just imagined some. There are 0 tasks in progress, 8 queued, and 59
  completed items still sitting in TODO.

  What is queued:
  Next backlog item: Capture status output — run `atris status` (default)
  and `atris status --verbose`, paste both into
  `atris/features/human-output/validate.md` under `## Surface: status`. For
  default mode only, mark pass/fail against ≤20 lines × ≤80 chars + "where
  we are / queued / blocking" sections present + non-technical
  approve-or-hold decidable. Verbose mode is captured for reference only, no
  pass/fail. Exit: section has both blocks + 4 check results for default..
  Inbox has 4 items.

  What is blocking:
  Main drag: 59 completed items should be cleared from TODO. No team
  activity is logged yet today.
```

Measurements: 24 content lines, max line width ≈78 chars.

| Check | Result | Notes |
|---|---|---|
| (i) ≤ 20 lines | **FAIL** | 24 content lines. Horizon paragraph in "Where we are" eats 9 wrapped lines; "What is queued" eats 9 more because it renders the full next-backlog-item sentence verbatim. |
| (ii) ≤ 80 chars wide | **PASS** | Wrapper at 74 + 2-space indent keeps every content line ≤78 chars. |
| (iii) "where we are / queued / blocking" sections present | **PASS** | All three section headers render, each with body copy. |
| (iv) non-technical approve-or-hold decidable | **PARTIAL** | Reader can see horizon + what's queued + what's blocking, but there is no explicit "Decision:" line like `examples.md`, so the approve/hold call is inferred not stated. |

Surface verdict: **FAIL** — width + sections pass, but 4 lines over the 20-line budget and the decision line is still implicit. Fix = summarize horizon in ≤2 sentences, truncate the "next backlog item" title to ~1 line, append a trailing `Decision: …` line.

### Verbose mode (reference only, no pass/fail)

Command: `node -e "require('./commands/status').statusAtris(false,false,true)"`

```text
┌──────────────────────────────────────────────────────────────────┐
│ TASK BOARD — 2026-04-08                                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   📋 Backlog (8)                                                 │
│   ├─ T21c: Capture status output — run `atris status` (def...    │
│   ├─ T21d: Capture validator/review output — run `atris re...    │
│   ├─ T21e: Write the T21 verdict summary at the bottom of ...    │
│   ├─ T23: Locate today's "heartbeat Notes line" writer — g...    │
│   └─ T24: Add `appendTickSummary(cwd, { time, outcome, hor...    │
│   └─ ... +3 more                                                 │
│                                                                  │
│   🔨 In Progress (0)                                             │
│   (none)                                                         │
│                                                                  │
│   ✅ Done (59)  ← clean these up                                 │
│                                                                  │
│   📥 Inbox (4)                                                   │
│   ├─ I3: Agent coordinator (IMPORTANT). Add a thin coordina      │
│   ├─ I4: Refinement to M2 (loop-self-seeds-horizons). Befor      │
│   ├─ I5: Rich per-tick visual interface. Every autopilot ti      │
│   └─ ... +1 more                                                 │
│                                                                  │
│   📚 Lessons (23)                                                │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ TEAM                                                              │
│                                                                  │
│   (no journal entries yet)                                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

  plan → do → review    (or: atris log to add ideas)
```

Captured for reference only — verbose mode is the legacy task-board surface
and is explicitly out of scope for the ≤20 × ≤80 human-output audit.

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
