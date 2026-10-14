---
name: isolated-slice-builder
description: Build one bounded code slice in an isolated checkout, prove it with a bare test command and git diff --check, and update MAP.md before review.
version: 1.0.0
tags:
  - build
  - verification
  - worktree
---

# Isolated Slice Builder

Use this skill when building a feature slice or dispatched task in an isolated checkout.

## Workflow

1. Read `atris/MAP.md` to jump directly to the target `file:line` locations.
2. Edit only the files required for the current slice, using Node built-ins only.
3. Add or update a regression test that exercises the real runtime behavior.
4. Run the bare test command (`node --test <file>`) and `git diff --check`.
5. Update `atris/MAP.md` if any exported function or command route changed.
