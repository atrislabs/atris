---
name: engines
description: "Dispatch coding work to an installed terminal agent — Codex, Cursor, Devin, or Atris Fast — as an interchangeable worker engine. Claude orchestrates: writes the bounded prompt, the engine builds, Claude verifies and lands. Triggers on: use codex, use cursor, use devin, use atris, engine, dispatch to, worker agent, second opinion build."
version: 1.1.0
tags:
  - engines
  - codex
  - cursor
  - devin
  - atris
  - orchestration
---

# Engines — interchangeable terminal workers

One contract, four engines. The orchestrator (you, Claude) writes a bounded task prompt, dispatches it to an engine, then **independently verifies, lands, and pushes** the result. Engines never self-certify.

## Invocation

| Engine | Command | Notes |
|--------|---------|-------|
| Codex | `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background [--write] "<prompt>"` (via codex plugin / codex:codex-rescue agent) | Poll with `status`, fetch with `result <job-id>` |
| Cursor | `cursor-agent --trust -p "<prompt>"` (run from the target repo) | Headless print mode; `--trust` required for non-interactive |
| Devin | `devin -p --permission-mode dangerous -- "<prompt>"` (run from the target repo) | Default permission mode is read-only for writes — build work NEEDS `--permission-mode dangerous`, so only run it in an isolated worktree. Also `devin cloud` for sessions that outlive this machine |
| Atris Fast | `atris chat --print "<prompt>"` (run from the target repo; equivalently `ax --fast --print`) | Headless JSON result `{ok, model, output, durationMs}`; exit 0 = ok. Serves via the api.atris.ai fast lane (glm-5.2) with a local tool runtime scoped to the cwd — reads, greps, small verified edits. ~1% of frontier cost, typical turns 5–40s |

## Picking an engine

- **Codex** — deep root-cause work, long autonomous builds, second-opinion diagnosis. Slowest; runs sandboxed.
- **Cursor** — fast bounded edits and refactors in a single repo.
- **Devin** — multi-step feature work; use `cloud` when the run should survive laptop sleep.
- **Atris Fast** — cheap bounded lookups, single-file facts, small verified edits, high-volume fan-out (ten questions = ten `--print` calls at pennies). Not for multi-file features or long builds. Use it before burning a frontier engine on grunt work.
- Parallel builds across repos: one engine job per repo, never two engines writing the same checkout.

## Atris Fast runtime requirements (verified live 2026-07-03)

- Must run from an **initialized Atris workspace** (an `atris/` folder) under an allowed workspace root (e.g. `~/arena/*`). `atris chat --print` outside one exits 1 with "Run atris init"; `ax --fast --print` outside an allowed root fail-closes with `{ok:false, error:"workspace_path must be under an allowed local workspace root"}`.
- In an allowed root **without** an `atris/` folder the turn silently routes to the cloud no-tools chat lane — the model will honestly refuse file work ("no Atris Desktop runtime attached"). If the output says that, you dispatched from the wrong directory; it is not an engine failure.

## Prompt contract (every dispatch)

1. Name the absolute repo path and tell the engine to `cd` there (Atris Fast scopes to the cwd it runs from — cd first, and name absolute paths in the prompt).
2. Bound the slice: one task, explicit exit criteria, the verify command to run.
3. Git rules: `git status` first; stage only own files; never revert others' changes; never destructive git; work on a branch `member/<name>-<slug>` or a worktree. (Atris Fast does not run git — for edit tasks the orchestrator commits after verifying.)
4. Require a final report: files changed, verify command + result, branch name. (Atris Fast returns one JSON `output` field — ask for file:line evidence in it.)

## Landing (orchestrator duties — never skip)

- **Codex sandbox cannot reach github.com and may get read-only repo access.** Expect temp clones / `git format-patch` fallbacks under `/private/tmp`. Apply patches in a fresh worktree, re-run the verify command yourself, then push.
- Cursor and Devin run unsandboxed — still re-run the verify command yourself before pushing.
- Atris Fast answers are model output over a real tool runtime — treat `output` as a claim, spot-check the cited file:line, and re-run any verifier yourself before acting on it.
- Engine task DBs and receipts written inside a sandbox are snapshots; reconcile against the live `atris task` plane after landing.
- A stalled job (no log output for 30+ min) gets cancelled and taken over; don't wait on it. Atris Fast turns that exceed ~60s have hung — kill and retry once with a tighter prompt.
