---
name: engines
description: "Dispatch coding work to an installed terminal agent — Codex, Cursor, or Devin — as an interchangeable worker engine. Claude orchestrates: writes the bounded prompt, the engine builds, Claude verifies and lands. Triggers on: use codex, use cursor, use devin, engine, dispatch to, worker agent, second opinion build."
version: 1.0.0
tags:
  - engines
  - codex
  - cursor
  - devin
  - orchestration
---

# Engines — interchangeable terminal workers

One contract, three engines. The orchestrator (you, Claude) writes a bounded task prompt, dispatches it to an engine, then **independently verifies, lands, and pushes** the result. Engines never self-certify.

## Invocation

| Engine | Command | Notes |
|--------|---------|-------|
| Codex | `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background [--write] "<prompt>"` (via codex plugin / codex:codex-rescue agent) | Poll with `status`, fetch with `result <job-id>` |
| Cursor | `cursor-agent --trust -p "<prompt>"` (run from the target repo) | Headless print mode; `--trust` required for non-interactive |
| Devin | `devin -p --permission-mode dangerous -- "<prompt>"` (run from the target repo) | Default permission mode is read-only for writes — build work NEEDS `--permission-mode dangerous`, so only run it in an isolated worktree. Also `devin cloud` for sessions that outlive this machine |

## Picking an engine

- **Codex** — deep root-cause work, long autonomous builds, second-opinion diagnosis. Slowest; runs sandboxed.
- **Cursor** — fast bounded edits and refactors in a single repo.
- **Devin** — multi-step feature work; use `cloud` when the run should survive laptop sleep.
- Parallel builds across repos: one engine job per repo, never two engines writing the same checkout.

## Prompt contract (every dispatch)

1. Name the absolute repo path and tell the engine to `cd` there.
2. Bound the slice: one task, explicit exit criteria, the verify command to run.
3. Git rules: `git status` first; stage only own files; never revert others' changes; never destructive git; work on a branch `member/<name>-<slug>` or a worktree.
4. Require a final report: files changed, verify command + result, branch name.

## Landing (orchestrator duties — never skip)

- **Codex sandbox cannot reach github.com and may get read-only repo access.** Expect temp clones / `git format-patch` fallbacks under `/private/tmp`. Apply patches in a fresh worktree, re-run the verify command yourself, then push.
- Cursor and Devin run unsandboxed — still re-run the verify command yourself before pushing.
- Engine task DBs and receipts written inside a sandbox are snapshots; reconcile against the live `atris task` plane after landing.
- A stalled job (no log output for 30+ min) gets cancelled and taken over; don't wait on it.
