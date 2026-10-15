# TODO.md

Details for any task: atris task show <ID>

> Regenerated from durable Atris task state. Do not treat this file as truth.

<!-- ATRIS_TODO_COMPACT:2 -->

## Endgame

**Slug:** zero-revision-nights
**Picked:** 2026-08-26 00:48
**Horizon:** Overnight agent work lands itself and holds up, proven the day Keshav reviews a full night of landed changes and changes nothing.
**Source:** user-prompt (Lauren Tan talk, atris/wiki/briefs/youtube-Cmoh-yR-usA.md)

## Backlog

(Empty)

## In Progress

- **[ECM-6]** Keep older programs out of recent CPU summaries · executor

## Review

- **[ECM-5]** Keep same-checkout repair hints runnable without Node on PATH · executor
  **Done looks like:** People can copy the startup repair command even when their shell cannot find Node, so repairing repeated agent starts remains possible.
- **[ECM-4]** Keep startup repair commands usable without node on PATH · executor
  **Done looks like:** People can now copy checkout repair commands even when their shell cannot find Node, so startup repair remains usable.
- **[ECM-3]** Honor empty command search path entries in startup hints · executor
  **Done looks like:** Operators can now repair startup leaks with the right installed command, which saves time when the shell searches the current folder.
- **[ECM-2]** Skip files that cannot run when finding the startup repair command · executor
  **Done looks like:** Operators can now copy a repair command that skips unusable files, so they avoid failed repairs and save time.
- **[ECM-1]** Quote startup repair command paths for the shell · executor
  **Done looks like:** Operators can now copy the startup repair command from folders with punctuation, so they avoid failed repairs and save time.

## Blocked

(Empty)

## Completed

(Empty)
