---
name: engines
description: Inspect and route Atris work across installed worker engines. Use when choosing codex, cursor, devin, claude, atris-fast, or another CLI engine for a bounded build or verification task.
version: 1.0.0
tags:
  - engines
  - orchestration
  - worker-agents
  - verification
---

# Engines

An engine is the intelligence that runs a bounded Atris task. The orchestrator owns scope and verification. Engines do not self-certify.

## Roster

Show installed engines and the current default:

```bash
atris engine
```

Switch the workspace default:

```bash
atris engine <name>
atris engine reset
```

Run one command on a specific engine without changing the default:

```bash
atris mission run "<objective>" --engine <name>
atris autopilot --auto --iterations=1 --engine <name>
atris run --engine <name>
```

Preflight an engine when available:

```bash
atris engine test <name>
```

## Engine Choices

- `atris-fast`: cheap, fast, bounded lookups and small edits.
- `codex`: deep root-cause work and longer autonomous builds.
- `cursor`: fast repo-local edits and refactors.
- `devin`: multi-step feature work, especially when the run should survive the local machine.
- `claude`: broad reasoning, critique, and implementation when installed as a CLI engine.

Use the local roster output as truth. If an engine is not ready, do not route work to it until the binary or login is fixed.

## Dispatch Contract

Every engine task needs:

1. Absolute repo path.
2. One bounded objective.
3. Files or systems in scope.
4. Exit criteria.
5. Verify command.
6. Git rules: status first, stage only own files, never destructive git.
7. Final report: files changed, verifier result, residual risk.

## Verification

After an engine returns, independently inspect the diff and rerun the verifier. If the engine wrote task receipts inside a sandbox or worktree, reconcile them with the live Atris task or mission state.

## Rules

- One writing engine per checkout.
- Use worktrees for parallel or risky work.
- Treat engine output as a claim until verified.
- Never let the builder be the only certifier.

