---
name: pre-commit-skeptic
description: Deliver a fresh-eyes verdict on multi-file refactors, schema changes, or API designs before code is written, naming the single sharpest failure mode.
version: 1.0.0
tags:
  - architecture
  - design-review
  - risk
---

# Pre Commit Skeptic

Use this skill before any migration, API boundary change, or refactor touching 3 or more files.

## Workflow

1. Read the actual target code and `atris/MAP.md` without inheriting the caller's assumptions.
2. Return a clear verdict (`proceed`, `proceed-with-changes`, or `stop`) in under 300 words.
3. Name the single most likely failure mode and the concrete safeguard required before building.
