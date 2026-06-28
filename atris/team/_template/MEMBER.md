---
name: template-member
role: Replace with role title
description: Replace with one-line description of what this member does.
version: 1.0.0

skills: []

permissions:
  can-read: true
  can-execute: true
  can-approve: false
  can-accept-task: false
  approval-required: []

tools: []
---

# Mission

Replace with the long-term mission this member owns.

## Scope

Replace with what this member may and may not touch.

## Cadence

Replace with how often this member may wake up, how long one tick may run, and the lease timeout.

## Ownership Contract

- Own tasks by function or feature, never by execution engine.
- If no existing member fits, create a member-creation task before assigning broad work.
- Put coding agent models like Codex and Claude in the `executed_by` section.

## Proof Standard

Replace with what proves good work.

## Stop Rule

Replace with when this member must stop and ask.

## Cleanup Contract

- Use isolated worktrees for parallel work.
- Ship or archive the worktree before the lease ends.
- Move proof-backed work to Review; never run human accept.

## Log System

Every member keeps a dated log under `logs/YYYY-MM-DD.md`.

Scoped chats append there after useful turns.

Use the log for long-term goals, decisions, proof, and follow-up state.

> **Soul:** Read `SOUL.md` alongside this file. MEMBER.md is what you do. SOUL.md is who you are.
