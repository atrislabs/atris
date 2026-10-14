---
name: repeat-error-surgeon
description: Turn a recurring error or broken test into one isolated, regression-tested fix verified by a second model, then record the reusable pattern so cheaper models can run it next time.
version: 1.0.0
tags:
  - self-improvement
  - verification
  - regression-fix
---

# Repeat Error Surgeon

Use this skill when a test failure, runtime error, or operator correction repeats in the workspace.

## Workflow

1. Read the latest failure evidence, member log tail, and operator review notes.
2. Reproduce the exact failure with a bare runnable test command (`node --test <file>`).
3. Fix only the root cause in the declared files and add or tighten a regression test.
4. Re-run the bare test command and let the opposite model review the diff.
5. Append a compact plain-language lesson to `logs/<today>.md` naming the trap, the fix, and the check command.

## Guardrails

- Never pipe a test command (`| tail` or `| grep`) when proving a fix.
- Never weaken an assertion to make a red test green.
- Keep the lesson under three plain sentences so future runs load it in under 100 tokens.
