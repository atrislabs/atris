---
name: west-coast-build
description: "Fast, high-leverage multi-model engineering loop for all Atris repos: West Coast low default effort, 4-role model diversity, light-context auto spec-prep, Lego reuse before new files, cross-vendor double team on security bricks, and bare verification. Use when planning, scouting, dispatching builders, or running multi-task campaigns."
version: 1.0.0
tags:
  - engines
  - orchestration
  - planning
  - workflow
---

# West Coast Build Technique

Model weights and thinking effort are separate axes. Run routine coding, scouting, and testing on `low` effort with fast context, and save heavy thinking strictly for unbounded strategy or stuck loops.

## 1. Lego Reuse First

Before writing a new module, command, or helper, check what the repo already has (`atris/MAP.md`, `mission`, `campaign`, `bench`, `fleet`, `swarm`, `roster`, `effort-router`, `spec-packet`). Sharpen or compose an existing brick first. Only add a new file when no real brick fits.

## 2. The Four Roles

Match model weights and effort to the job:

1. **Coordinator (Session Model):** Everyday strategy, architectural boundaries, exact spec packets, bare grading, and clean landings. Never burn heavy reasoning on routine edits.
2. **Deep Thinker (`fable 5.2` or `gpt-6.2-astra` at `high`, `gpt-6.2-sol` at `xhigh`):** Reserved strictly for uncertain, unbounded architecture decisions or one-turn read-only `/audible` diagnosis after two repeated test misses. Feed them clean scout context (`prep: search`). Never put them on routine execution loops.
3. **Everyday Worker (`opus 5.5` at `low` default, `medium` for review):** Default straight-shot builder for real design, messy multi-file wiring, live network or integration tests, deeper edge-case suites, and end-to-end work.
4. **Sprinter (`gpt-6.1-terra` or `haiku 5.5` at `low`):** Default for fast read-only scouts, auto spec-prep, computer use, strict JSON triage, and crisp compressed standalone units where the spec is locked down.
   - Fast Codex invocation: `codex exec -m gpt-6.1-terra -c model_reasoning_effort=low -c 'service_tier="fast"' --ignore-user-config -s workspace-write --ephemeral -C <worktree> "<spec>" </dev/null`
   - Fast Claude invocation: `claude -p --model opus --effort low --permission-mode bypassPermissions --no-session-persistence "<spec>"` (or `--model haiku --effort low` for read-only scouts).

## 3. Auto Spec-Prep Before Dispatch

Before dispatching any builder, verify what is already fixed on `origin/master` (or `origin/main`) versus genuinely open, and lock a zero-ambiguity spec packet:

- Exact allowed files (scope lock)
- Exact contracts and invariants to preserve
- Exact bare verify command (never pipe through `tail` or `grep`; a pipe hides exit codes)
- Explicit boundary on what not to touch

`lib/roster-prep.js` (`runSpecPrepPass`) compiles light-context scout output directly into a validated `lib/spec-packet.js` packet.

## 4. When to Double Team

Run a cross-vendor double team (`gpt-6.1-terra low` + `opus 5.5 low` in parallel in two clean detached copies from `origin/master` or `origin/main`) **only on permanent foundational or security-critical bricks** you never want to rewrite:

- Terra tends to write 35% to 50% tighter code; Opus writes deeper edge-case regression suites and catches subtle repo conventions.
- Grade both diffs independently, run every check bare outside any sandbox, merge the cleanest passing code with the strongest tests, and reap every throwaway copy immediately.

## 5. Two-Miss Audible Rule

If a builder misses its verify command twice on the same task, stop retrying at `low`. Run one read-only diagnosis pass (`/audible` via `fable 5.2` or `gpt-6.2-astra` at `high`, or `gpt-6.2-sol` at `xhigh`), fix the spec or root cause, and finish cleanly on `low`.

## 6. Clean Copy and Verification Discipline

- Never edit a dirty primary checkout when it tracks prod or scheduled jobs; branch a clean copy from `origin/master` (or `origin/main`) and reap it once landed or pushed.
- Never trust a builder's prose report alone; inspect `git diff --stat` and run the bare verify command yourself.
- Protected lanes (auth, billing, real money, deploy, security) get full bare proof and a clean review PR unless the owner explicitly approved direct merge.
