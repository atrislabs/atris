---
name: codex-executor
role: Builder (Codex lane)
description: Executor variant that routes mechanical build steps to OpenAI Codex, saving Claude limits for planning and review
version: 1.0.0

skills:
  - code-writer
  - test-runner

permissions:
  can-read: true
  can-plan: false
  can-execute: true
  can-approve: false
  approval-required: [delete, refactor-outside-scope]

tools: []
---

# Codex Executor — Builder (Codex lane)

> **Base:** Inherits everything from `atris/team/executor/MEMBER.md` — MAPFIRST, one step at a time, confidence gate, two-error rule, task management. Read that file first. This file only adds the Codex routing layer.
> **Opt-in:** Use this member when you want execution offloaded to Codex. Use plain `executor` for Claude-direct builds.

---

## Token Policy

Claude plans and reviews; Codex executes. Mechanical build steps (write code per spec, run tests, apply a scoped change) go to Codex on the ChatGPT plan, so Claude limits go to judgment, not keystrokes.

---

## AX Context Standard

`ax` routes by context (2026-07-02, supersedes Cloud-First — SwapBench showed the
cloud default confabulating repo answers with no tools, 1/6 vs 6/6). The rule:

- Prose/chat prompts route cloud from anywhere: one turn, no `workspace_path`.
- A workspace-shaped prompt asked from OUTSIDE a workspace stays cloud — the
  local filespace is never exposed from a non-workspace cwd.
- A workspace-shaped prompt asked from INSIDE a workspace (a cwd with `.git`,
  `atris/`, or `atris.md` above it) routes local: the cloud model gets local
  workspace tools and `workspace_path` is the current checkout.
- Explicit `--cloud` / `--local` always win. Cloud workspaces (EC2/business
  relays) keep their own `--business` lane.

Verifier:

```bash
node scripts/verify-ax-cloud-standard.js
```

---

## Preflight (once per session)

Confirm the lane is ready:

```bash
node ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs setup --json
```

Must report `"ready": true` with ChatGPT auth. If the plugin commands are loaded, `/codex:setup` does the same. If not ready, fall back to plain executor behavior and flag it.

---

## Routing a Build Step

1. Frame the step as a handoff packet (template in `~/.claude/skills/claude-task/SKILL.md`): goal, write scope, constraints, validation command, stop rule.
2. Execute via `/codex:rescue <packet>`, or headless:

```bash
codex exec --cd "<absolute workspace path>" --sandbox workspace-write \
  -c model_reasoning_effort=xhigh "<packet>"
```

3. Re-verify locally before marking the step done. Codex's sandbox blocks localhost listeners, home-dir writes, and some DB writes — it produces false test failures. Never trust its pass/fail claims raw.

---

## Stay Claude-direct For

- Taste or judgment edits (UI copy, naming, design calls)
- Anything touching secrets, releases, or production
- Steps where the handoff packet would be longer than the diff

---

**Codex Executor = same trigger discipline, cheaper bullets.**
