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

Command: `node bin/atris.js review` (T21d re-capture against a no-op
workspace state — `## In Progress` holds only the T21d claim itself, no
code changes pending review).

```text
atris review — validator.
i checked the workspace. map is present, todo is present, 11 feature validate scripts queued.
next i'll run tests, walk each validate.md, and clean completed tasks out of todo.md.
(run `atris review --verbose` for the full prompt + appendix.)

next: `atris do` to fix issues, then `atris review` again.
```

Measurements: 6 content lines (8 incl. trailing blank), max line width 93 chars.
Exit-status: command succeeded (no error, no "needs in-progress task" branch) —
the default surface prints a pre-run banner regardless of workspace state, so
the "n/a — needs in-progress task" fallback does not apply here.

| Check | Result | Notes |
|---|---|---|
| (i) ≤ 20 lines | **PASS** | 6 lines. |
| (ii) ≤ 80 chars wide | **FAIL** | Line 2 is 93 chars, line 3 is 85. No wrap applied. |
| (iii) plain-language verdict | **PARTIAL** | Plain language, but the default mode prints a forward-looking "next i'll…" rather than a verdict against a completed change. Reads as "about to review" not "reviewed". |
| (iv) non-technical approve/hold decidable | **FAIL** | No verdict line. The reader cannot tell if there is anything to approve — the default surface is a pre-amble, not a review result. Matches the T21d "no in-progress task" condition: there is nothing in `## In Progress` for review to verdict on, so the command is showing its "about to start" banner. |

Surface verdict: **FAIL** — width overrun on 2 lines, and the default non-`--verbose` review surface does not produce a chief-of-staff verdict block at all. Closest `examples.md` shape ("Validator pass") is not emitted today. This surface still needs the T19 rewrite for review-phase output.

## Verdict

Rule: a surface passes iff all four checks (≤20 lines, ≤80 chars, plain
language / required sections, non-technical approve-or-hold decidable) are
green. Overall pass iff every in-scope surface passes.

| Surface | Pass/Fail | Notes |
|---|---|---|
| autopilot tick | **FAIL** | (i) 36 lines FAIL, (ii) 78 chars PASS, (iii) plain language PASS, (iv) horizon + next step readable PASS. Budget blown by full horizon paragraph rendering every tick. |
| status (default) | **FAIL** | (i) 24 lines FAIL, (ii) ≤78 chars PASS, (iii) where/queued/blocking sections PASS, (iv) approve-or-hold PARTIAL — no explicit `Decision:` line. Also gated by `.atris/business.json` hijacking `atris status` into `businessStatus('pallet')`. |
| review (validator) | **FAIL** | (i) 6 lines PASS, (ii) 93 chars FAIL, (iii) plain-language PARTIAL — pre-run banner, not verdict, (iv) approve/hold FAIL — no verdict line. Needs the T19 rewrite. |

**Overall: FAIL.** Every in-scope surface misses at least one check. Closest
to green: status (sections present, cosmetic width + budget misses). Farthest
from green: review (no verdict block in default mode).

Top fixes, in priority order:
1. review surface — emit a 3-paragraph validator-pass block per `examples.md`, wrap to ≤ 80 chars, include an explicit "Decision:" line. (T19 scope.)
2. autopilot tick — render horizon in ≤ 2 sentences per tick so the budget holds at ≤ 20 lines across banner + pick + done. Cache full horizon text for boundary ticks only.
3. status — tighten wrap width to 78, collapse horizon to one sentence, append explicit "Decision: …" line.
4. status routing — either make `atris status` prefer `statusAtris` and require an explicit `atris status <biz>` for businessStatus, or have businessStatus also honor the chief-of-staff shape.

Shipping history (link chain for the reader):
- **T15** — surface audit in `atris/features/human-output/idea.md` under `## Surface audit` (2026-04-08 Completed).
- **T16** — target shapes drafted in [`examples.md`](./examples.md): happy-tick, idle-tick, validator-pass, each ≤12 lines and ≤80 chars wide (2026-04-08 Completed in `atris/TODO.md`).
- **T17** — autopilot tick rewrite in `commands/autopilot.js`; default now briefs in plain language, `--verbose` keeps the boxy legacy view (2026-04-08 Completed in `atris/TODO.md`).
- **T18** — `atris status` rewrite to chief-of-staff format (where / queued / blocking); `--verbose` keeps the legacy task board (2026-04-08 Completed in `atris/TODO.md`).
- **T20** — `appendTickSummary` wired into `autopilotAtris` end-of-tick (happy/idle/halted); idle blocks preserve `0 tasks in 0s` for `getIdleTickCount` (2026-04-08 Completed in `atris/TODO.md`).
- **T21 / T21a–d** — this validate pass: surfaces table + per-surface capture + four-check scoring (2026-04-08 Completed in `atris/TODO.md`).
- **T21e** — this verdict summary (current task).

## T20 heartbeat

Captured from `atris/logs/2026/2026-04-08.md` `## Notes` — the most recent
heartbeat block written by `appendTickSummary` at the end of an autopilot tick
(5:15 pm PDT, T25 verification tick). This is the CLI-written block T20 ships,
not an agent-written line.

```text
- 5:15 pm
  I planned, built, and reviewed "Verify T25 wiring already shipped — confirm `commands/autopilot.js:1271-1289` calls `appendTickSummary` with horizon from `readHorizonSlug` (:631), idle branch sets `idle=true` when `completed===0 && tickOutcome!=='halted'`, halted branch sets `tickNextStep='stop until a human looks at the error'`, and the whole block is try/catch-guarded. If all four hold, mark T25 done in Completed and skip T25b/c. If any gap, file a focused follow-up. Exit: T25 either checked off or replaced by a precise gap task.".
  We are still on the loop-self-seeds-horizons endgame.
  Next tick will pick the next endgame task.
```

Measurements: 4 content lines, max line width **543 chars** (line 2 — the
verbatim task title is reflowed onto a single physical line). The idle-tick
variant (15:00 smoke at journal lines 319–323) is 5 lines / max 56 chars and
contains the literal `0 tasks in 0s` marker required by `getIdleTickCount`.

Scored against the four T27 checks:

| # | Check | Result | Notes |
|---|---|---|---|
| i | ≤20 lines × ≤80 chars | FAIL | 4 lines (pass) but max width 543 chars (fail) — verbatim task title reflowed onto one physical line on the captured 5:15 pm happy-tick block. Idle variant (journal :319–323) passes both axes (5 lines / 56 chars). |
| ii | matches an `examples.md` shape (happy / idle / validator-pass) | PASS | Captured block matches `happy-tick` shape (timestamp → "I planned, built, and reviewed …" → endgame line → next-tick line). Idle variant matches `idle-tick` shape. |
| iii | idle tick → block contains literal `0 tasks in 0s` | PASS | Idle variant at journal :319–323 contains `0 tasks in 0s`. The captured 5:15 pm block is a happy tick, so this check is N/A there but holds for the idle case the spec targets. |
| iv | `getIdleTickCount(process.cwd())` ≥1 after an idle tick | FAIL (current state) | Smoke `node -e "const {getIdleTickCount}=require('./commands/autopilot.js'); console.log(getIdleTickCount(process.cwd()))"` → `0`, because the most recent `## Notes` entry today is the 5:15 pm happy tick, not an idle one (consecutive-from-bottom counter resets). After the 15:00 idle tick was the last write, the counter did report ≥1 (per T20 smoke notes). The helper is wired correctly; the live count is just gated on the most recent tick being idle.

**Surface verdict: FAIL** — heartbeat writer ships and shape/marker checks
pass, but the line-width budget blows up whenever the task title is long, and
`getIdleTickCount` only reads ≥1 immediately after an idle tick (expected, but
worth flagging as a follow-up so the heartbeat soft-wraps long titles to ≤80).

