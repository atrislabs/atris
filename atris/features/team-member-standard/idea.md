# Team Member Standard (MEMBER.md)

> **Status:** implemented (core)
> **Created:** 2026-02-16
> **Last Updated:** 2026-02-16

---

## Problem Statement

AI tooling has fragmented standards: CLAUDE.md for project instructions, AGENTS.md for agent definitions, RULES.md for Cursor, SKILL.md for individual capabilities, .mcp.json for tool servers. Nobody has a standard for a complete AI team member — the bundle of skills, tools, persona, context, and permissions that turns a generic AI into a specific worker. Teams cobble this together with prompts and hope it holds.

---

## Solution Design

MEMBER.md — an open-source standard for defining a complete AI team member. One directory per member, containing everything that member needs to do their job: who they are (persona), what they can do (skills), what tools they have (.mcp.json), what they know (context), and what they're allowed to do (permissions).

Atris defines the spec, open sources it, and builds the best tooling around it. The standard is tool-agnostic — works with Claude, Codex, Cursor, any agent framework. Atris is the reference implementation.

---

## ASCII Visualization

```
         EXISTING STANDARDS (fragmented)

  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │CLAUDE.md │ │AGENTS.md │ │ RULES.md │
  │(Anthropic│ │(OpenAI/  │ │(Cursor)  │
  │ project) │ │ Codex)   │ │          │
  └──────────┘ └──────────┘ └──────────┘
  ┌──────────┐ ┌──────────┐
  │ SKILL.md │ │.mcp.json │
  │(Claude   │ │(MCP      │
  │ Code)    │ │ protocol)│
  └──────────┘ └──────────┘


         NEW STANDARD (unified)

  ┌─────────────────────────────────────────────┐
  │  MEMBER.md — the team member definition     │
  │                                             │
  │  ┌─────────────────────────────────────┐    │
  │  │  Persona + Role + Permissions       │    │
  │  │  (who they are, what they can do)   │    │
  │  └─────────────────────────────────────┘    │
  │                                             │
  │  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
  │  │ skills/  │ │.mcp.json │ │ context/ │    │
  │  │          │ │          │ │          │    │
  │  │ SKILL.md │ │ tools +  │ │ docs the │    │
  │  │ SKILL.md │ │ servers  │ │ member   │    │
  │  │ SKILL.md │ │          │ │ needs    │    │
  │  └──────────┘ └──────────┘ └──────────┘    │
  └─────────────────────────────────────────────┘


         DIRECTORY STRUCTURE

  team/
  ├── sdr/
  │   ├── MEMBER.md              ← persona, role, permissions
  │   ├── skills/
  │   │   ├── email-outreach/SKILL.md
  │   │   ├── crm-sync/SKILL.md
  │   │   └── lead-research/SKILL.md
  │   ├── .mcp.json              ← HubSpot, LinkedIn servers
  │   └── context/
  │       ├── playbook.md
  │       ├── icp.md
  │       └── pricing.md
  │
  ├── fde/
  │   ├── MEMBER.md
  │   ├── skills/
  │   │   ├── skill-builder/SKILL.md
  │   │   ├── customer-onboarding/SKILL.md
  │   │   └── integration-setup/SKILL.md
  │   ├── .mcp.json              ← GitHub, customer workspace
  │   └── context/
  │       ├── fde-sop.md
  │       └── customer-list.md
  │
  └── ops/
      ├── MEMBER.md
      ├── skills/
      │   ├── invoice-processing/SKILL.md
      │   └── vendor-management/SKILL.md
      ├── .mcp.json              ← QuickBooks, Stripe
      └── context/
          └── vendor-contracts.md


         HIERARCHY

  Project Level
  ┌──────────────────────────────────┐
  │  CLAUDE.md / AGENTS.md / RULES.md│ ← project instructions
  └──────────────┬───────────────────┘
                 │
  Team Level     │
  ┌──────────────▼───────────────────┐
  │  MEMBER.md                       │ ← team member definition
  │    ├── skills/ (SKILL.md)        │ ← capabilities
  │    ├── .mcp.json                 │ ← tools
  │    └── context/                  │ ← knowledge
  └──────────────────────────────────┘

  Everything below MEMBER.md already exists.
  MEMBER.md is the glue.
```

---

## Success Criteria

- [ ] MEMBER.md spec is defined with clear frontmatter schema (name, role, skills, mcps, permissions)
- [ ] `atris member create <name>` scaffolds a complete member directory (MEMBER.md + skills/ + context/)
- [ ] `atris member list` shows all team members with their skill counts and status
- [ ] `atris member link <name>` symlinks the member's skills to Claude/Codex/Cursor system directories
- [ ] Members can reference shared skills (from atris/skills/) and have their own custom skills
- [ ] A member directory is portable — zip it, hand it to someone, it works
- [ ] The spec is tool-agnostic — nothing in MEMBER.md is Claude-specific or Codex-specific
- [ ] Open source spec published with reference examples

---

## User Impact

**For companies (Pallet, Mercury):** "Here's your SDR agent" is a folder, not a prompt chain. Onboard a new AI team member by dropping a directory. Fire one by deleting it. The team structure is visible, auditable, and version-controlled.

**For FDEs (Justin):** Build a complete team member in a customer session, not just a skill. "I set up your SDR agent with email outreach, CRM sync, and your sales playbook loaded. Here's the MEMBER.md."

**For the ecosystem:** An open standard that any AI tool can adopt. Claude reads MEMBER.md, Codex reads MEMBER.md, Cursor reads MEMBER.md. Atris publishes the spec, builds the best tooling, and becomes the default way teams define AI workers.

**For the business:** The standard is free. The implementation is $100K/yr. Same play as Docker (open spec, paid platform), Kubernetes (open standard, paid cloud), or Terraform (open source, paid enterprise).

---

## Technical Notes

### MEMBER.md Frontmatter Schema

```yaml
---
name: sdr                          # kebab-case identifier
role: Sales Development Rep        # human-readable title
description: Outbound prospecting and lead qualification
version: 1.0.0

# Skills this member has — can reference shared or local
skills:
  - email-outreach                 # local: ./skills/email-outreach/
  - calendar                      # shared: atris/skills/calendar/
  - slack                         # shared: atris/skills/slack/

# Permissions — what the member can and can't do
permissions:
  can-send: false                  # can't send emails without approval
  can-draft: true                  # can draft emails
  can-schedule: true               # can create calendar events
  can-delete: false                # can't delete anything
  approval-required: [send, delete, publish]

# MCP tools — references .mcp.json in member directory
mcps:
  - hubspot
  - linkedin
---
```

### Shared vs Local Skills

Members can use two types of skills:
- **Shared skills** — from `atris/skills/` (universal, like email, calendar)
- **Local skills** — in the member's own `skills/` directory (custom to this role)

When linking, shared skills are symlinked from the project. Local skills are symlinked from the member directory. No duplication.

### Context Directory

The `context/` folder holds documents the member needs to know. These get loaded into the AI's context when the member is activated. Examples:
- Sales playbook
- Company pricing
- ICP definition
- SOPs
- Customer-specific docs

Context is markdown. No special format. Just docs the member references.

### Portability

A member directory is fully self-contained:
```bash
zip -r sdr-agent.zip team/sdr/
# Hand it to someone, they unzip, it works
```

The only external dependency is shared skills (referenced by name). If the recipient has atris, shared skills resolve automatically. If not, the member still works with just its local skills.

### Relationship to Existing Standards

| Standard | Scope | Owned By | MEMBER.md Relationship |
|----------|-------|----------|----------------------|
| CLAUDE.md | Project instructions | Anthropic | MEMBER.md sits below, per-member |
| AGENTS.md | Agent definitions | OpenAI | MEMBER.md is more complete (includes skills, tools, context) |
| RULES.md | Editor rules | Cursor | MEMBER.md can include rules in persona section |
| SKILL.md | Individual capability | Claude Code | MEMBER.md bundles multiple skills |
| .mcp.json | Tool servers | MCP Protocol | MEMBER.md includes per-member MCP config |

MEMBER.md doesn't replace any of these. It composes them into a complete worker definition.
