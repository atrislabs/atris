---
name: member-runtime
description: "Load and run MEMBER.md team members -- complete AI workers with persona, skills, tools, context, and a journal that learns over time. Use when you want to activate a team member, run 'be my chief of staff', or manage stateful AI workers."
version: 1.0.0
tags:
  - ai-agents
  - team-management
  - stateful-skills
  - member-format
  - workflow
---

# Member Runtime

This skill teaches you how to load and run MEMBER.md team members. A member is a skill that manages skills -- it bundles a persona, capabilities, tools, permissions, and a journal that gets smarter over time.

Format spec: https://github.com/atrislabs/member

## What is a MEMBER.md?

A MEMBER.md is a directory (or single file) that defines a complete AI worker:

```
team/{name}/
  MEMBER.md              # Who this worker is (persona, workflow, rules)
  skills/                # What they can do (SKILL.md files)
  context/               # What they know (domain knowledge)
  tools/                 # What they use (API docs, configs)
  journal/               # What they've learned (grows over time)
```

## How to Load a Member

When the user activates a member (e.g., "be my chief of staff", "act as the sdr"), follow these steps:

### 1. Find the member

Look for the member definition in order:
1. `team/{name}/MEMBER.md` (directory format)
2. `team/{name}.md` (flat file format)

If not found, tell the user: "Member '{name}' not found. Install one from ClawHub or create team/{name}/MEMBER.md."

### 2. Parse the frontmatter

Read the YAML frontmatter between `---` delimiters. Extract:
- `name` -- the member's identifier
- `role` -- their job title
- `skills` -- list of capability names
- `permissions` -- what they can and can't do
- `tools` -- what external tools they need

### 3. Load skills

For each skill in the frontmatter `skills` list:
1. Check `team/{name}/skills/{skill-name}/SKILL.md`
2. If found, read it and incorporate the instructions
3. If not found, treat it as an abstract capability (the member knows how to do this but has no local definition)

### 4. Load context

Read all markdown files in `team/{name}/context/`. These are domain knowledge the member references while working -- playbooks, reference docs, default preferences. Load them into your working context.

### 5. Read the journal

This is what makes members stateful. Before doing anything:

1. Search memory for past entries from this member: `memory_search("{member-name} preferences patterns")`
2. Read today's and yesterday's memory files for recent journal entries
3. Read `MEMORY.md` for durable preferences this member has recorded

If no journal entries exist (first run), proceed with defaults from `context/preferences.md`.

### 6. Become the member

Adopt the persona, workflow, and rules from the MEMBER.md body. You are now this member. Follow their workflow step by step. Respect their permissions -- if `can-send: false`, draft but don't send.

### 7. Write the journal

After completing the task, write a journal entry to `memory/YYYY-MM-DD.md`:

```markdown
## {member-name} - {date}

**Task:** What was requested
**Delivered:** What was produced
**User reaction:** What the user engaged with, asked follow-up about, or ignored
**Pattern:** Any emerging preference (e.g., "user prefers bullets over prose")
```

If a pattern has been consistent for 3+ days, promote it to `MEMORY.md` as a durable preference.

## Permissions Enforcement

The member's `permissions` field declares intent. Enforce it:

- `can-*: false` -- Don't do this action. Draft instead and ask for approval.
- `approval-required: [action]` -- Pause before this action and ask the user.
- If no permissions are declared, default to asking before any external action (send, delete, schedule).

## Multiple Members

Users can install multiple members. Each has its own persona, skills, and journal entries in memory. When switching between members, load the new member's MEMBER.md fresh -- don't carry over the previous member's persona.

To list installed members: scan `team/` for MEMBER.md files and flat .md files.

## Installing Members

Members are installed by placing their files in `team/`. This happens via:
- `clawhub install {member-name}` -- from ClawHub marketplace
- Manual creation -- user creates `team/{name}/MEMBER.md`
- Copy from another project -- member directories are portable (zip and share)
