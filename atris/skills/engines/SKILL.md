---
name: engines
description: "Dispatch work to an installed terminal agent or named Atris engine profile. Supports Atris Fast, Claude, Codex, Cursor, Fable, Composer, Haiku, Devin, Grok, and Antigravity (agy). Triggers on: use codex, use cursor, use devin, use grok, use agy, use antigravity, use gemini, gemini session, use fable, use claude, use atris, engine, dispatch to, worker agent, second opinion build."
version: 1.4.2
tags:
  - engines
  - claude
  - codex
  - cursor
  - fable
  - composer
  - haiku
  - devin
  - grok
  - agy
  - antigravity
  - gemini
  - atris
  - orchestration
---

# Engines — interchangeable terminal workers

One contract, ten live profiles. The orchestrator writes a bounded task prompt, dispatches it to an engine, then **independently verifies, lands, and pushes** the result. Engines never self-certify.

## three verbs

- ask: `atris engine <name> "<question>"`; pin a model with `atris engine <name> --model <model> "<question>"`
- build: `atris engine <name> <task-id>`
- switch: `atris engine <name>`

## Fable means Fable

Use `atris engine fable "<bounded question>"` for Fable's take. The canonical
profile pins `claude-fable-5`, gives deep Fable asks ten minutes by default,
and records the resolved model in the receipt. An explicit `--model` or
`--timeout` still wins.

## Raw binary fallback and debugging

Raw spawns are not the default because they skip Atris receipts, watch, and coaching.

| Engine | Command | Notes |
|--------|---------|-------|
| Atris Fast | `atris chat --print "<prompt>"` (equivalently `ax --fast --print`) | Local tool runtime over the api.atris.ai fast lane. Best for bounded lookups and small verified edits. |
| Claude | `claude -p "<prompt>"` | Uses the local Claude configuration. Add `--model opus` for maximum-depth review or `--model sonnet` for speed. |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox -o <result-file> "<prompt>"` (run from the target repo/worktree; read-only research: `--sandbox read-only`) | Headless, exits when done — run it as a tracked background Bash task like the other engines and completion auto-wakes the session. Final answer lands in the `-o` file. Verified live 2026-08-11. Outside a git repo add `--skip-git-repo-check` or it exits 1. ONE-SHOT SESSIONS (`claude -p` workers): run codex in the FOREGROUND and wait — a one-shot session never wakes again, so backgrounding strands the result (observed 2026-08-11). The old plugin path (`codex-companion.mjs task --background`) is deprecated for dispatch: its job store never notifies the session (a finished result sat unread overnight, 2026-08-10) |
| Cursor | `cursor-agent --trust -p "<prompt>"` (run from the target repo) | Headless print mode; `--trust` required for non-interactive |
| Fable | `claude -p "<prompt>" --model claude-fable-5` | Raw fallback only. Prefer `atris engine fable` so the model, longer timeout, live log, and receipt stay honest. |
| Composer | `atris run "<objective>" --engine composer` | Fast navigator/executor profile routed through the installed `ax` binary. |
| Haiku | `claude -p "<prompt>" --model claude-haiku-4-5` | Fast validation and bounded read-only checks. |
| Devin | `devin -p --permission-mode dangerous -- "<prompt>"` (run from the target repo) | Default permission mode is read-only for writes — build work NEEDS `--permission-mode dangerous`, so only run it in an isolated worktree. Also `devin cloud` for sessions that outlive this machine. Supports `--model swe-1.7` |
| Grok | `grok --always-approve -p "<prompt>"` (run from the target repo) | Headless single-turn via `-p`; default model grok-4.6. Very fast on lookups (~5-10s, reads MAP first). Great for quick second opinions; use `--best-of-n <N>` for tricky bounded builds. Uses grok.com login |
| Antigravity | `agy --mode accept-edits --add-dir "$PWD" -p "<prompt>"` (run from the target repo) | `agy` executor profile; also answers to "gemini". **`--add-dir` is mandatory for writes** — without it agy edits its own scratch folder (`~/.gemini/antigravity-cli/scratch/`) and the project never changes, which looks like a silent failure (verified live 2026-08-28). Use `--mode plan --sandbox` for read-only review, `--model <id>` to pin a model, and `--dangerously-skip-permissions` if a build still stalls on an approval prompt. |

Headless dispatch permissions (verified 2026-08-11): `codex exec`, `grok`, and `cursor-agent` are allowlisted in `~/.claude/settings.json` so fresh and one-shot sessions can dispatch without a human approval click. A cold session that gets "requires approval" on an engine command means that allowlist regressed.

## Picking an engine

- **Atris Fast** — cheap bounded lookups, single-file facts, small verified edits, and high-volume fan-out.
- **Claude / Fable** — deep review, synthesis, validation, and complex builds. Use Fable when judgment quality matters most.
- **Codex** — deep root-cause work, long autonomous builds, second-opinion diagnosis. Slowest; runs sandboxed.
- **Cursor** — fast bounded edits and refactors in a single repo.
- **Composer / Haiku** — fast, bounded navigation, edits, and validation where a max-tier model would be wasteful.
- **Devin** — multi-step feature work; use `cloud` when the run should survive laptop sleep.
- **Grok** - fastest frontier lookups and quick second opinions (grok-4.6, ~5-10s; reads MAP first); use `--best-of-n` for tricky bounded builds. Uses grok.com login.
- **Antigravity / agy** — flexible executor work across Gemini, Claude, and GPT-OSS models; use `agy` as the canonical short name.
- Parallel builds across repos: one engine job per repo, never two engines writing the same checkout.

## Models worth pinning (verified live 2026-08-15)

Each engine CLI can pin a specific model. Current best picks:

| Engine | Flag | Best models today |
|--------|------|-------------------|
| Claude | `--model opus` | `opus` follows the local Claude alias; use an explicit model identifier for reproducibility |
| Fable | `--model claude-fable-5` | Canonical Fable 5 route; `atris engine fable` pins it automatically |
| Devin | `--model swe-1.7` | `swe-1.7` (free right now: use it as the volume executor for parallel bounded slices), `swe-1.7-lightning` for speed |
| Cursor | `--model cursor-grok-4.6-xhigh` | `cursor-grok-4.6-xhigh` for second-opinion builds, `cursor-grok-4.6-high-fast` for quick pinned asks (answered in ~12s live 2026-08-12), `composer-2.5` for fast edits; parameterized Claude via `'claude-opus-4-8[effort=high]'`; `--list-models` shows the full menu |
| Composer | `--engine composer` | `composer 2.5` through the Atris profile |
| Haiku | `--model claude-haiku-4-5` | `haiku` for fast validation |
| Grok | (default) | `grok-4.6` default (confirmed live 2026-08-12, ~5s lookup), `grok-4.5` still available via `-m` |
| Codex | `-m <model>` | CLI default rides `~/.codex/config.toml`; pin with `-m` only when the task needs it |
| Antigravity / agy | `--model <id>` | `gemini-3.7-flash-high` for speed, `gemini-3.1-pro-high` for depth, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, or `gpt-oss-120b-medium` |
| Atris Fast | (fixed) | api.atris.ai fast lane |

Re-verify this table when a lab ships a new model: run each CLI's model-list command, smoke one lookup, and update the row. Free-tier windows (like swe-1.7 now) are the moment to fan out volume work.

## Keep the local roster current

Run `atris engine doctor`, then `atris engine --help`. The canonical profiles live in `lib/runner-command.js`; tiers, roles, models, duties, and health live in `lib/engine-registry.js`. When this guide and the live roster disagree, the registry is the source of truth and this guide must be updated.

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
- Long Devin runs (5+ min) can return empty stdout even when the build fully succeeded — judge by `git status` and the diff in its worktree, never by the printed report.
- Atris Fast answers are model output over a real tool runtime — treat `output` as a claim, spot-check the cited file:line, and re-run any verifier yourself before acting on it.
- Engine task DBs and receipts written inside a sandbox are snapshots; reconcile against the live `atris task` plane after landing.
- A stalled job (no log output for 30+ min) gets cancelled and taken over; don't wait on it. Atris Fast turns that exceed ~60s have hung — kill and retry once with a tighter prompt.
