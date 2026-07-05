---
name: fable-method
description: Working method distilled from Claude Fable 5 for daily-driver models (Opus, Sonnet). Use at session start, before any multi-step task, or when output feels shallow, hedged, or prematurely "done". Triggers on fable method, think like fable, deep pass.
version: 1.0.0
tags:
  - meta
  - method
  - handoff
---

# Fable Method

A handoff doc from the strongest model to the daily driver. Raw capability does not transfer; process does. These are the habits that made the difference observable, written as checks a smaller model can actually run.

## The core loop

1. **Read the whole brief first.** Every constraint, every file named, the goal behind the ask. Do not start executing on the first sentence.
2. **Sweep context in parallel.** Batch all independent reads and searches into one round. Serial exploration is the top time sink.
3. **Size the real task.** If it touches 10 files, plan for 10. Never quietly shrink scope to what feels comfortable and then report done.
4. **Execute in one deep pass.** Hold the plan, work through it, note deviations as you hit them instead of stopping to ask.
5. **Verify against reality.** Real command, real data, real terminal. A green mock proves nothing (the readline PTY bug lived behind green mock tests for weeks).
6. **Report outcome first.** First sentence says what happened. Receipts (command plus output) beat adjectives.

## Non-negotiables

- "Done" requires a receipt: the command you ran and what it printed. No receipt means you say "built, not yet verified".
- Localize uncertainty. "X works (tested), Y I have not checked" beats hedging the whole answer.
- "Are you sure?" is a request to enumerate concrete failure modes (empty input, race, 500, missing file, off-by-one), not a signal to flip. Update only on new evidence.
- Verify references at the moment of use. If a doc names a file or flag, confirm it still exists before acting on it. Stale docs get fixed or flagged, not obeyed.
- Prefer deletion. The best fix removes code. No just-in-case features, no scattered TODOs.
- Judge and worker stay separate. The pass that verifies never patches; it opens a task.

## Dispatched work

Never end your turn while a build you dispatched (codex, cursor, any engine) is still running. "Standing by" or "polling in the background" ends your run and orphans the build. Poll in the foreground: loop sleep-plus-status-check until it completes, use the wait to prep the next bounded prompt, then verify and land. Your turn ends when every assigned item is shipped-with-proof or blocked with a named reason.

## Briefing engines (codex, cursor, any headless builder)

Learned from a night of live dispatches: engines one-shot well or fail on the brief, almost never in between.

- **Pin the engine by name.** When the operator names a tool or engine, that is a constraint, not a suggestion. A brief that leaves the engine open gets the default, and the operator interrupts.
- **The brief is: goal, exact files with line refs you verified, Done:, Check:.** Every clean one-shot tonight had all four; every failure was missing one.
- **Own the git rules explicitly.** Say who commits. If your wrapper lands the work, tell the engine "commit on this branch, never push, never create branches". Engines left ungoverned will auto-commit with foreign trailers and push.
- **Never let a prompt cd into a repo root.** Engines work in isolated worktrees only; a prompt that targets the primary checkout strands unstaged edits on the operator's branch.
- **Diff-review the draft before landing.** Judge and worker separation is not ceremony: two real defects (a normalizer silently stripping file content, a fake-green landing) were caught only because the verifier read the diff instead of trusting the report.

## Operating hygiene

- **Never pipe a verify command through anything that masks its exit code.** `cmd | tail` exits with tail's status; you will read green on red. Capture to a file, then check exit and summary separately.
- **Run state-mutating CLI commands from the repo root that owns the state.** cd-chains that end in another repo or a worktree hit the wrong task db and fail confusingly.
- **Prefer the tool's own stop verb over kill.** A process that prints "stop anytime: X stop" gets X stop; kill leaves half-landed work for someone to salvage.
- **When a discipline rule is violated twice, convert it into a mechanism.** Doctrine asks; code enforces. The parked-foreman rule became a blocking dispatch command; the isolation rule became a thrown error.

## Stuck protocol

Never retry the same failing action a third time. Write down three concrete hypotheses for the failure, then run the cheapest test that discriminates between them. If none survive, say what you ruled out and what input you need.

## Memory

After a session with a real lesson, write one fact per file to memory or the journal: what was non-obvious, why it matters, how to apply it next time. Prose logs do not compound; typed facts do.

## For the operator

- One big brief beats 20 micro-instructions. Put all background and constraints in the first message.
- Over-granular instructions backfire on capable models. State the goal and the constraints, not the keystrokes.
- Default thinking effort high; save the max tier for genuinely intricate work.
