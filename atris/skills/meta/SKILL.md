---
name: meta
description: Metacognition and delegation science skill for AI agents. Use when starting work, coordinating parallel team members, feeling stuck, output feels off, or before complex tasks. Do not use for trivial one-line lookups when the route and fix are already known. Triggers on meta, delegation, coordinate, parallel members, stuck, or self-check.
version: 1.1.0
tags:
  - meta
  - metacognition
  - delegation
  - coordination
---

# Meta Skill

How to be an effective agent and coordinator. Load this when you need to check yourself or delegate across a team.

## When to activate

- Starting a new session (orientation)
- Delegating work across multiple team members (`atris member run` / `atris member board`)
- Feeling stuck or uncertain
- Output feels sloppy or generic
- Complex task ahead
- After a mistake

## When NOT to activate

- Single-file mechanical lookups where `atris/MAP.md` already gives the exact line and command
- Mid-execution of a single bounded test command that is already passing
- Routine read-only status checks that require no planning or delegation

## Context awareness

1. **MAP first** - Read `atris/MAP.md` before any search. It's the index.
2. **Journal context** - Check today's log for recent work, patterns, blockers.
3. **atris/lessons.md** - What failed before? Don't repeat.
4. **Skill routing** - Frontend? Load `design`. Backend? Load `backend`. Writing? Load `writing`.

## Pace control

| Signal | Action |
|--------|--------|
| Simple task, clear path | Execute fast |
| Complex task, multiple approaches | Slow down, plan first |
| Uncertain about intent | Ask ONE question |
| Output feels off | Pause, re-read context |
| Stuck > 2 attempts | Escalate, don't spiral |
| 3+ independent slices | Delegate in parallel to team members |

## The science of delegation

When work spans multiple concerns, shift from solo builder to team coordinator:

1. **Partition by disjoint files** - Assign each member (`builder`, `architect`, `executor`, `auto-improver`, `orb`) a distinct file set so parallel branches never conflict at merge time.
2. **Bind a scoped, falsifiable check** - Pass an explicit `--verify "node --test test/[scoped].test.js"` that tests only the files the member touches. Never bind a broad suite that mutates or reads shared global state during a parallel run.
3. **Launch isolated, bounded runs** - Default to a short bounded window (`--minutes 30`) in an isolated repo copy with independent referee review; use multi-hour `--hours` or `--spend-full-budget --detach` only when the operator explicitly asks for a long or overnight run:
   ```bash
   atris member run [member] "[objective]" --runner auto --verify "node --test test/[file].test.js" --minutes 30 --ignite
   ```
4. **Monitor live telemetry, not guesswork** - Watch `atris member board` and `atris member result [member]`. If a member is `quiet` past its cadence or hits a repeated error streak, inspect its log and restaff or ping it via `atris member ping [member] "[guidance]"`.
5. **Judge diffs, never prose** - Long runs can omit their final text summary even when all files and tests succeeded. Always verify `git status --short`, `git log -n 3`, and run the scoped test command inside the member's repo copy before marking ready or rejecting.
6. **Close the loop through review gates** - Move verified work to Review with `atris task ready [id] --proof "[command and exit 0]"` and wait for human acceptance (`atris task accept [id]`) or the owner's explicit `atris autoland` policy before merging onto `origin/master` and running `atris member tidy --dry-run`.

## Safety and failure handling

- **Human approval and landing gate** - Agents prepare proof and move tasks to Review; never run `atris task accept`, never push or merge to `origin/master` without human approval or active owner-enabled `atris autoland`, and never launch multi-hour detached runs unless explicitly requested by the operator.
- **Protected lanes** - Changes touching auth, billing, session, CSP, security, or production deploy always pause for explicit human review, even when `autoland` is on.
- **Git hook respect** - If a pre-commit or pre-push hook blocks a commit, stop and fix the root cause. Never bypass hooks with `--no-verify`.
- **Worktree hygiene** - Never delete a work folder while git locks exist or a process is still active inside it; preview with `atris member tidy --dry-run` before removing merged copies.
- **Repeated failure breaker** - If a member fails the same check twice in a row, halt that approach, record the cause in `atris/lessons.md`, and restaff with a narrower slice.

## Self-correction triggers

Stop and reassess when:
- You're about to search without checking MAP
- You're writing code during PLAN phase
- You're adding features not requested
- You're explaining instead of doing
- You've used words like "robust", "comprehensive", "streamlined"
- Two delegated members are editing the same file

## Memory leverage

Before acting:
1. Check `atris/lessons.md` - short lessons from past mistakes
2. Check `atris/features/` - prior art for similar work
3. Check journal history - `grep -i "<keyword>" atris/logs/**/*.md`

## Skill composition

You can stack skills:
- `meta` + `design` = thoughtful frontend work
- `meta` + `backend` = careful API design
- `meta` + `writing` = deliberate prose
- `meta` + `autopilot` = multi-member parallel execution

Meta is the foundation. Domain skills are the specialization.

## The loop

```
Orient (read context)
    ↓
Decide (solo or delegate? which skill? what pace?)
    ↓
Act (execute with focus or dispatch disjoint members)
    ↓
Check (verify diff, scoped tests, and member board)
    ↓
Learn (add to lessons.md if miss, promote to skill at 2-3x)
```

## Verification and closure

A solo or delegated task is complete only when all four checks pass with concrete evidence on disk:
1. The scoped test command (`node --test test/[file].test.js`) is run bare (no pipes) and exits `0`.
2. `git diff --check` exits `0` with no whitespace errors or conflict markers, and `git status --short` shows only declared files changed.
3. For delegated runs, `atris member board` shows `done ok` (active or quiet runs are still in progress, never complete) and `atris member result [member] --json` points to a passing receipt in `atris/runs/`.
4. Any modified skill passes `atris skill audit [name]` with `12/12` (0 errors, 0 warnings) and `atris skill eval atris/skills/[name]/SKILL.md` with `passed: true` and all rubric scores `>= 4`.

## Anti-patterns

- Grepping before MAP check
- Coding during planning
- Adding unrequested features
- Verbose explanations
- Guessing instead of asking
- Repeating past mistakes
- Delegating overlapping files to parallel workers
- Judging a run by its prose summary instead of its git diff and test exit code
- Creating skill without symlinking to .claude/skills/ (won't load mid-session)

## Skill evolution

Skills improve from your mistakes:
1. After REVIEW, log learnings to `atris/lessons.md` (one line per lesson)
2. Repeated lessons (2-3x) get promoted into the relevant skill
3. Next agent loads the improved skill

You're training future agents. Leave the codebase smarter than you found it.

## One-liner

Think before you act. Partition cleanly when you delegate. Check yourself. Use the system.
