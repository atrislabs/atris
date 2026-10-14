---
name: cross-model-referee
description: Audit worker diffs from an independent model perspective, run bare test commands, block slop or unverified claims, and emit actionable fix instructions.
version: 1.0.0
tags:
  - review
  - verification
  - referee
---

# Cross Model Referee

Use this skill when validating a plan before execution or auditing a worker diff before merge.

## Workflow

1. Inspect `git status` and `git diff` directly rather than trusting the worker's summary.
2. Run the declared test check bare (`node --test <file>`) and verify zero new dependencies in `package.json`.
3. Check that `atris/MAP.md` was updated if any file or command route changed.
4. Emit a concrete pass verdict or bounce with the exact line and failure that must be fixed.
