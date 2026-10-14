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

- **[CLI-188]** Finish the folder protection: log every removal path and check git's own activity before deleting
- **[CLI-187]** Engine runs should record machine memory and load, and say why a run was killed
- **[CLI-179]** Desktop infinity loop should tick live gated member missions, including ones whose state lives in a worktree [desktop]
- **[CLI-178]** Mission start reads a time inside the objective as the budget [mission]

## In Progress

- **[CLI-184]** Engine git calls must respect a person's own ssh setup, and slow-network timeouts must not stall a flight · fleet-claude

## Review

- **[CLI-186]** Engine git calls: say 'timed out' instead of blank, tell the person when a new worktree is cut from a stale base, and stop spawning an extr… · fleet-claude
  **Done looks like:** Three failing-first tests pass; hygiene, ratchet, dispatch and fleet suites pass in a real git checkout.
- **[CLI-185]** Engine work folders must never be deleted while a run is using them, and every folder removal must say who removed it and why · fleet-claude
  **Done looks like:** A worktree with a live process or recent git activity is kept by reap; every removal leaves a log line; failing-first tests; hygiene and land suites pass in a …
- **[CLI-183]** Unattended engine runs must never stop on a password prompt or ship to a renamed-away branch · fleet-codex
  **Done looks like:** New tests fail without the change and pass with it; the named file, the named file and the dispatch, fleet and one-lap suites pass; no new model names outside …
- **[CLI-182]** A finished engine build should never be paused or rerun because its normal output mentions being logged out · fleet-codex
  **Done looks like:** New tests fail without the change and pass with it; the named file and the named file and the the named file suites pass; no new model names outside the the na…
- **[CLI-181]** Engine builds should land in repos whose main branch is not called master, and say plainly when an engine refuses to run · fleet-codex
  **Done looks like:** New tests fail without the change: a temp repo whose default branch is main lands a build; a fake engine that prints a refusal pauses with that exact sentence.…
- **[CLI-180]** Engine builds should start, retry, and land without a person nudging them · fleet-codex
  **Done looks like:** Three new tests fail without the change and pass with it; the named file and the named file still pass; no model names added to lib files outside the the named…

## Blocked

(Empty)

## Completed

(Empty)
