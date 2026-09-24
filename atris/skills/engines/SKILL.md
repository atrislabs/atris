---
name: engines
description: "Dispatch work to an installed terminal agent or named Atris engine profile. Supports Atris Fast, Claude, Codex, Cursor, Fable, Composer, Haiku, Devin, Grok, Antigravity (agy), and opencode. Triggers on: use codex, use cursor, use devin, use grok, use agy, use antigravity, use gemini, gemini session, use fable, use claude, use opencode, use atris, engine, dispatch to, worker agent, second opinion build."
version: 1.7.0
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
  - opencode
  - atris
  - orchestration
---

# Engines: interchangeable terminal workers

One contract, eleven live profiles. The orchestrator writes a bounded task prompt, dispatches it to an engine, then **independently verifies, lands, and pushes** the result. Engines never self-certify.

## Pick the job owner first

Before choosing an engine for search, build, or review, run `atris engine roster` and use that job's pick. Only deviate when the user names an engine. The roster is project policy and does not depend on team member files.

## three verbs

- ask: `atris engine <name> "<question>"`; pin a model with `atris engine <name> --model <model> "<question>"`
- build: `atris engine <name> <task-id>`
- switch: `atris engine <name>`

## FABLE: use the Atris profile

FABLE is a canonical Atris CLI engine profile, not a model nickname. When the
operator asks for Fable's take, opinion, critique, or second perspective, use:

```bash
atris engine fable "<bounded question>"
```

This routes through `lib/engine-ask.js`, which supplies the read-only preamble,
bounded tools, plan permission mode, safe mode, no session persistence, live
logs, a receipt, and engine-health classification. The CLI owns the underlying
Claude invocation through the `fable` profile in `lib/runner-command.js`.

Do not replace this with raw `claude -p` and call the result FABLE. Do not impose
one global timeout either. Use the CLI default for bounded asks. For deep
architecture work, repo-wide reviews, or evidence-heavy judgment, choose a
deliberately longer `--timeout` based on the scope, up to the CLI limit, and keep
waiting while FABLE is making progress. FABLE quality can require time; the
timeout is a safety boundary, not a speed target.

On failure, inspect the Atris receipt and report it plainly. Retry once with a
larger bound only when the evidence shows the bound was too short. Never silently
substitute raw Claude or another engine and call the result FABLE.

## Raw binary fallback and debugging

Raw spawns are not the default because they skip Atris receipts, watch, and coaching.

Smoke: `reply with the word OK`, run from `$HOME`, 120s cap, one at a time on a loaded Mac (2026-09-23). Seconds are wall time under that load.

| Engine | Exact command | Pinned model | Verified | Seconds | Notes |
|--------|---------------|--------------|----------|--------:|-------|
| Atris Fast | `atris chat --print "<prompt>"` | `atris:fast` | 2026-09-23 | 3.2 | Needs an initialized `atris/` workspace; see runtime requirements below. |
| Claude | `claude -p "<prompt>" --model claude-opus-5-5 --output-format json --no-session-persistence` | `claude-opus-5-5` | 2026-09-23 | 20.3 | `--model opus` also resolves to `claude-opus-5-5` today; pin the id for reproducibility. |
| Codex | `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral -m gpt-6-sol -c model_reasoning_effort=high -o <result-file> "<prompt>" </dev/null` (run from the target repo/worktree; read-only: swap the bypass flag for `--sandbox read-only`) | `gpt-6-sol`, high | 2026-09-23 | 13.8 | Keep the `</dev/null`: with stdin open codex prints "Reading additional input from stdin..." and waits forever (observed 2026-09-23). Outside a git repo add `--skip-git-repo-check` or it exits 1 (re-checked 2026-09-23). Final answer lands in the `-o` file. Run as a tracked background Bash task; in one-shot `claude -p` workers run it in the FOREGROUND, a one-shot session never wakes again (2026-08-11). `codex-companion.mjs task --background` is deprecated: its job store never notifies the session (2026-08-10). |
| Cursor | `cursor-agent --trust --model composer-2.5 -p "<prompt>"` (run from the target repo) | `composer-2.5` | 2026-09-23 | 37.5 | `--trust` required for non-interactive. |
| Fable | `atris engine fable --timeout 120 --json "<question>"` | `claude-fable-5` | 2026-09-23 | 21.4 | Canonical read-only FABLE ask with receipt; scale `--timeout` to the work. |
| Composer | `cursor-agent --trust --model composer-2.5 -p "<prompt>"` | `composer-2.5` via Cursor | 2026-09-23 | 37.5 | Same binary as Cursor. |
| Haiku | `claude -p "<prompt>" --model claude-haiku-4-5 --output-format json --no-session-persistence` | `claude-haiku-4-5` | 2026-09-23 | 19.0 | Fast validation and bounded read-only checks. |
| Devin (build) | `devin -p --permission-mode dangerous --model swe-2-max --prompt-file <brief>` (run from an isolated worktree) | `swe-2-max` (Free tag in `devin models list`, 2026-09-23) | 2026-09-23 | 14.0 | In `-p` mode the default permission mode rejects shell commands too, so even a read-only audit dies after one step (2026-09-23). Keep the brief outside the worktree. Long runs (5+ min) can print nothing even on success: judge by the worktree diff. `devin cloud` outlives this machine. |
| Devin (search) | `devin -p --permission-mode dangerous --model swe-1.7-lightning -- "<prompt>"` | `swe-1.7-lightning` (paid, no Free tag on 2026-09-23) | 2026-09-23 | 13.9 | |
| Grok | `grok --always-approve --model grok-4.7 -p "<prompt>"` (run from the target repo) | `grok-4.7` | 2026-09-23 | 11.7 | Unpinned default is now `grok-4.7-build-fast`; `grok models` lists the menu. Uses grok.com login. `--best-of-n <N>` for tricky bounded builds. |
| Antigravity (agy) | `agy --mode accept-edits --add-dir "$PWD" --model gemini-3.8-flash-high --output-format json -p "<prompt>"` (run from the target repo) | `gemini-3.8-flash-high` | 2026-09-23 | 15.9 | **`--add-dir` is mandatory for writes**: without it agy edits `~/.gemini/antigravity-cli/scratch/` and the project never changes (2026-08-28). `--mode plan --sandbox` for read-only review. Also answers to "gemini". |
| opencode | `opencode run -m opencode/muse-spark-1.3-contributor-free "<prompt>"` (read-only: add `--agent plan`) | `opencode/muse-spark-1.3-contributor-free` | 2026-09-23 | 41.1 | Build work needs `--auto` (isolated worktree only). `opencode models` lists the live menu. |

Headless dispatch permissions (verified 2026-08-11): `codex exec`, `grok`, and `cursor-agent` are allowlisted in `~/.claude/settings.json` so fresh and one-shot sessions can dispatch without a human approval click. A cold session that gets "requires approval" on an engine command means that allowlist regressed.

## Picking an engine

- **Cheap bounded errands**: Devin `swe-2-max` while its Free tag holds (check `devin models list`).
- **Multi-file or long build**: Use the project's build pick. If there is no pick, use the router's choice.
- **Judgment-heavy build**: Opus 5.5 subagent (Claude row).
- **Review / deep judgment**: FABLE profile; Codex `gpt-6-sol` or Opus 5.5 as second validator.
- **Quick fix**: Cursor.
- **Search / bounded lookup**: Atris Fast; Haiku or Devin `swe-1.7-lightning` for read-only sweeps; Grok for quick second opinions.
- **agy / opencode**: extra executors when you want a different model family.
- Parallel builds across repos: one engine job per repo, never two engines writing the same checkout.

## Models worth pinning (verified live 2026-09-23)

| Engine | Flag | Alternates on the live menu |
|--------|------|-----------------------------|
| Claude | `--model <id>` | `claude-opus-5-5`, `claude-haiku-4-5` |
| Devin | `--model <id>` | `swe-2-max`, `swe-2-high`, `swe-2-medium` (Free); `claude-opus-5-5-high`, `gpt-6-sol` (paid) |
| Cursor | `--model <id>` | `composer-2.5`, `grok-4.7-xhigh`, `claude-opus-5-thinking-high`; `--list-models` |
| Grok | `--model <id>` | `grok-4.7`, `grok-4.7-build-fast` (default), `grok-4.6`, `grok-4.5`; `grok models` |
| Codex | `-m <id>` | `gpt-6-sol` is the `~/.codex/config.toml` default |

Pins expire 30 days after their verified date. Re-verify on a new model: run the CLI's model list, smoke one prompt, update the row.

## Keep the local roster current

Run `atris engine doctor`, then `atris engine --help`. The canonical profiles live in `lib/runner-command.js`; tiers, roles, models, duties, and health live in `lib/engine-registry.js`. When this guide and the live roster disagree, the registry is the source of truth and this guide must be updated.

## Atris Fast runtime requirements (verified live 2026-07-03)

- Must run from an **initialized Atris workspace** (an `atris/` folder) under an allowed workspace root (e.g. `~/arena/*`). `atris chat --print` outside one exits 1 with "Run atris init"; `ax --fast --print` outside an allowed root fail-closes with `{ok:false, error:"workspace_path must be under an allowed local workspace root"}`.
- In an allowed root **without** an `atris/` folder the turn silently routes to the cloud no-tools chat lane. The model will honestly refuse file work ("no Atris Desktop runtime attached"). If the output says that, you dispatched from the wrong directory; it is not an engine failure.

## Prompt contract (every dispatch)

Before build, fetch and identify the configured remote default, compare the
checkout to it, and preserve unrelated work. Record the base before editing.
Use the existing feature packet and functional owner; link source task IDs
across workspaces rather than copying a second plan. Load the relevant owner
bundle once. Live `atris task` records are truth; TODO.md is a rendered view.

If scouting, request at most 200 words naming the exact current mission,
owner, engine/model, files, checks, and risks. Reject an answer about an old
mission. Hand the accepted packet to the builder; reread only to resolve a
named gap. Use raw task metadata and events for exact paths and instructions,
never the simplified explanation. Verify requested models; never substitute
silently. Existing user authorization covers execution within that scope;
required plan review, CI, human-only acceptance, and deploy gates still apply.

Review related finished changes as one batch in a fresh context. Reuse a
review only while those bytes remain unchanged; changed bytes require
revalidation. Run required checks before the existing delivery path. Inspect
the actual final state: draft, queued, and merged are different outcomes.
Record elapsed time, engine calls, retries, and exposed token usage. Unknown
usage stays unknown; one pilot does not establish a speedup or perfect accuracy.

1. Name the absolute repo path and tell the engine to `cd` there (Atris Fast scopes to the cwd it runs from, so cd first and name absolute paths in the prompt).
2. Bound the slice: one task, explicit exit criteria, the verify command to run.
3. Git rules: `git status` first; stage only own files; never revert others' changes; never destructive git; work on a branch `member/<name>-<slug>` or a worktree. (Atris Fast does not run git. For edit tasks the orchestrator commits after verifying.)
4. Require a final report: files changed, verify command + result, branch name. (Atris Fast returns one JSON `output` field. Ask for file:line evidence in it.)

## Landing (orchestrator duties, never skip)

- **Codex sandbox cannot reach github.com and may get read-only repo access.** Expect temp clones / `git format-patch` fallbacks under `/private/tmp`. Apply patches in a fresh worktree, re-run the verify command yourself, then push.
- Cursor and Devin run unsandboxed. Still re-run the verify command yourself before pushing.
- Long Devin runs (5+ min) can return empty stdout even when the build fully succeeded. Judge by `git status` and the diff in its worktree, never by the printed report.
- Atris Fast answers are model output over a real tool runtime. Treat `output` as a claim, spot-check the cited file:line, and re-run any verifier yourself before acting on it.
- Engine task DBs and receipts written inside a sandbox are snapshots; reconcile against the live `atris task` plane after landing.
- A stalled job (no log output for 30+ min) gets cancelled and taken over; don't wait on it. Atris Fast turns that exceed ~60s have hung. Kill and retry once with a tighter prompt.
