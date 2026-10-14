---
name: loophole-proof-planner
description: Turn messy operator intent into single-slice tasks with exact file:line pointers, falsifiable bare test commands, and explicit rollback plans.
version: 1.0.0
tags:
  - planning
  - navigation
  - confidence-gate
---

# Loophole Proof Planner

Use this skill when turning a broad idea or goal into an executable roadmap.

## Workflow

1. Read `atris/MAP.md` first to locate exact `file:line` references without blind searching.
2. Split work touching 4 or more files into ordered single-slice tasks.
3. Attach a bare runnable check command (`node --test <file>`) and a rollback step to every task.
4. Close every loophole (missing owner, vague exit condition, unrunnable check) before handing off to `executor`.
