---
name: create-member
description: "Create and manage AI team members using the MEMBER.md format. Use when the user wants to define a new AI role, set up a team member, create an agent persona, or work with team/MEMBER.md files."
version: 1.0.0
tags:
  - team
  - member
  - agent
  - persona
---

# Member Creator

Create AI team members using the MEMBER.md format. A member is a directory that bundles persona, skills, tools, and context into a deployable AI worker.

## What is MEMBER.md

MEMBER.md defines a complete AI team member. It composes existing standards (SKILL.md for capabilities, .mcp.json for tool servers) into a single portable unit.

Spec: https://github.com/atrislabs/member

## Directory Structure

```
team/<name>/
├── MEMBER.md       REQUIRED  Persona + role + permissions
├── skills/         OPTIONAL  SKILL.md files (capabilities)
│   └── <skill>/
│       └── SKILL.md
├── tools/          OPTIONAL  MCP servers, API docs, CLI docs
│   ├── .mcp.json
│   └── <tool>.md
└── context/        OPTIONAL  Domain knowledge (markdown)
    └── *.md
```

## Creating a Member

When the user asks to create a team member, follow these steps:

### Step 1: Ask what role

Ask the user:
- What role is this member? (e.g., SDR, support agent, code reviewer)
- What should they be able to do?
- What should they NOT be able to do?

### Step 2: Create the directory

```
team/<name>/
├── MEMBER.md
├── skills/
├── tools/
└── context/
```

Use kebab-case for the name. Create all four directories even if empty.

### Step 3: Write MEMBER.md

Use this structure:

```yaml
---
name: <kebab-case-name>
role: <Human Readable Title>
description: <one line — what this member does>
version: 1.0.0

skills: []

permissions:
  can-read: true
---
```

Below the frontmatter, write three sections:

**Persona** — How the member communicates. Tone, style, decision-making approach. Be specific — "direct and research-driven" is better than "professional and helpful."

**Workflow** — Numbered steps the member follows. This is the core operating procedure. Each step should be a concrete action.

**Rules** — Hard constraints. What the member must always or never do. Keep it to 3-5 rules.

### Step 4: Add permissions

Common permission patterns:

```yaml
# Read-only member (planner, researcher)
permissions:
  can-read: true
  can-execute: false

# Builder with guardrails
permissions:
  can-read: true
  can-execute: true
  can-delete: false
  approval-required: [delete, deploy]

# Full access (reviewer, admin)
permissions:
  can-read: true
  can-execute: true
  can-approve: true
  can-ship: true
```

Permissions are declarations, not enforcement. They tell the agent what its boundaries are. The agent respects them because they're in its instructions.

### Step 5: Add skills (optional)

If the member needs specific capabilities, create SKILL.md files:

```
team/<name>/skills/<skill-name>/SKILL.md
```

Each skill follows the standard SKILL.md format:

```yaml
---
name: <skill-name>
description: <what this skill does>
---

# <Skill Name>

<Instructions for how to perform this capability>
```

Update the member's frontmatter to list the skill:

```yaml
skills:
  - <skill-name>
```

### Step 6: Add context (optional)

Drop markdown files into `context/` with domain knowledge the member needs:
- Playbooks, SOPs, guidelines
- Customer profiles, ICPs
- Reference docs, templates

No special format. Just markdown files the member references.

## Flat File Format

For simple members that just need a persona (no skills, tools, or context), use a flat file:

```
team/<name>.md
```

Same frontmatter, same format. Just no directory structure around it.

## Detection

Add to your project's CLAUDE.md (or AGENTS.md for Codex):

```markdown
## Team

This project uses MEMBER.md team members in `team/`.
When activated as a specific member, read `team/<name>/MEMBER.md`.
```

## Multi-Agent Usage

Activate different members for different tasks:

```
"Act as the navigator. Read team/navigator/MEMBER.md and plan this feature."
"Act as the validator. Read team/validator/MEMBER.md and review these changes."
```

Each member gets its own persona, skills, permissions, and context.

## Examples

### Dev team member (code reviewer)

```yaml
---
name: reviewer
role: Code Reviewer
description: Reviews PRs for correctness, security, and style
version: 1.0.0
skills: []
permissions:
  can-read: true
  can-approve: true
  can-execute: false
---

## Persona
Thorough but not pedantic. You catch real bugs, not style nits.
If something works and is readable, approve it.

## Workflow
1. Read the diff
2. Check for bugs, security issues, breaking changes
3. Approve or request specific changes (no vague feedback)

## Rules
1. Never block on style alone
2. Every comment must be actionable
3. If unsure, approve with a note
```

### Business role (SDR)

```yaml
---
name: sdr
role: Sales Development Rep
description: Outbound prospecting and lead qualification
version: 1.0.0
skills:
  - email-outreach
  - lead-research
permissions:
  can-draft: true
  can-send: false
  approval-required: [send, delete]
tools:
  - hubspot
  - apollo
---

## Persona
Research-driven. Every email references something specific about
the prospect. If you can't find a hook, don't send.

## Workflow
1. Research the lead
2. Qualify against ICP (context/icp.md)
3. Draft personalized sequence
4. Flag for human approval

## Rules
1. Never send without approval
2. Every email must reference something specific
3. Log everything to CRM
```
