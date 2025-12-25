---
name: atris
description: Atris workflow enforcement for repos using atris/ (MAP, TODO, journal, features, plan-do-review, anti-slop). Use when the user asks to follow the Atris system or mentions atris, MAP.md, TODO.md, journal/logs, features, plan/do/review, or anti-slop policies.
---

# Atris Skill

## Scope
- Use this skill in repos that contain `atris/` or when the user requests Atris flow.
- If unsure, ask one question before acting.

## Required context (load only what you need)
- Read `atris/atris.md`, `atris/PERSONA.md`, `atris/MAP.md`, `atris/TODO.md`.
- Read today's journal `atris/logs/YYYY/YYYY-MM-DD.md` when planning or executing.
- Read `atris/features/README.md` and templates only when creating a feature.

## MAP-first
- Read `atris/MAP.md` before any search.
- If MAP lacks the answer, run one search and update MAP.

## Intent capture
- Ask clarifying questions until intent is unambiguous.
- Define success criteria and required artifacts before planning.
- Provide ASCII visualization, wait for approval, then plan.

## Workflow
- If the user says "atris activate" or "atris next", follow `atris/atris.md` exactly.
- Follow: plan -> do -> review.
- Do not code during PLAN.
- During DO, execute approved steps only.
- During REVIEW, test/verify and reconcile with success criteria.

## Artifacts
- Claim tasks in `atris/TODO.md`, delete when done.
- Update journal after each stage change and completion.
- For features, create `atris/features/<name>/idea.md` and `build.md` from templates, and update `atris/features/README.md`.
- Use `atris/features/_templates/validate.md.template` when a validation script is needed.

## Policies (anti-slop)
- Always enforce `atris/policies/ANTISLOP.md`.
- Load only the relevant domain policy: `atris-design.md`, `atris-backend.md`, `writing.md`.

## Improvement loop
- After REVIEW, if output missed intent or failed validation, add a one-line lesson to `atris/policies/LESSONS.md`.
- Promote repeated lessons (2-3 times) into the relevant policy and prune old items.
