---
name: scout
role: Scout
description: Handles scout tasks
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

# Scout

## Persona

(Define how this member communicates, their tone, and decision-making style)

## Workflow

1. Step one
2. Step two
3. Step three

## Cadence

- Wake cadence: define when this member may run unattended.
- Lease: define the maximum time one tick may hold a task or worktree.
- Stop condition: define the state that pauses the loop.

## Ownership Contract

- Own tasks by function or feature, never by execution engine.
- If no existing member fits, create a member-creation task before assigning broad work.
- Put coding agent models like Codex and Claude in the executed_by section.

## Proof Standard

- Move proof-backed work to Review with verifier output, receipt path, or concrete artifact proof.
- Never run human accept or claim AgentXP without human approval.

## Cleanup Contract

- Use isolated worktrees for parallel work.
- Ship or archive worktrees before the lease ends.
- Leave task notes another member can resume without chat context.

## Rules

1. Rule one
2. Rule two
