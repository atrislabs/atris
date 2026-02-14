---
name: skill-improver
description: Audit and improve Claude skills against the Anthropic skill guide. Use when creating new skills, improving existing ones, or preparing skills for ClawHub distribution. Triggers on skill audit, improve skill, new skill, skill quality, or ClawHub publish.
version: 1.0.0
tags:
  - developer-tools
  - skill-management
  - quality
---

# Skill Improver

Audit and improve skills to match the Anthropic skill guide standard.

## When to activate

- User wants to create a new skill
- User wants to improve an existing skill
- Preparing a skill for ClawHub or external distribution
- After `atris skill audit` reports warnings or failures

## The standard

A well-formed skill has:

1. YAML frontmatter with `name` (kebab-case, matches folder), `description` (WHAT + WHEN + triggers, under 1024 chars), `version` (semver), `tags`
2. No XML tags anywhere in the file
3. Clear numbered instructions with concrete steps
4. Error handling guidance
5. Examples of input and expected output
6. Under 5000 words in SKILL.md (move detail to `references/` subdirectory)

## Audit process

1. Run `atris skill audit [name]` for mechanical checks (12 automated checks)
2. Read the SKILL.md for qualitative issues:
   - Is the description specific enough to trigger correctly?
   - Do instructions have concrete steps, not vague guidance?
   - Are there before/after examples?
   - Is error handling covered?
   - Would a new agent understand this without extra context?
3. Score: mechanical (CLI) + qualitative (your judgment)

## Fixing common problems

### Weak descriptions

Bad: "Essay writing skill. Triggers on: essay, draft"

Good: "Structured essay writing with approval gates at each stage (inbox, outline, panel, write, passes). Use when writing essays, drafts, outlines, or long-form content. Triggers on essay, draft, write, outline, or long-form."

Pattern: WHAT it does (1 sentence) + WHEN to use it (1 sentence) + trigger words woven in.

### Missing trigger phrases

Triggers go IN the description field, not as a separate `triggers` key. The Anthropic spec only recognizes `name` and `description` as required fields.

### Vague instructions

Bad: "Follow the writing process"

Good:
1. Capture raw ideas in inbox format
2. Build topic skeleton with evidence slots
3. Run panel review (AI challenges claims, user approves)
4. Write section by section, getting approval at each gate
5. Run three passes: argument (AI), read-aloud (human), sanity (both)

### Name mismatch

The `name` field must match the folder name exactly. Folder `backend` needs `name: backend`, not `name: atris-backend`.

### XML tags in content

XML-style tags (angle brackets around words) are forbidden. Replace them with bracket notation like `[text]` or plain text. The skill system rejects XML in SKILL.md content.

## Creating a new skill

1. Create folder: `atris/skills/[kebab-name]/`
2. Create `SKILL.md` with this template:

```markdown
---
name: your-skill-name
description: What this skill does. Use when [specific scenarios]. Triggers on [keywords].
version: 1.0.0
tags:
  - tag-one
  - tag-two
---

# Your Skill Name

One-line summary of what this skill does.

## When to activate

- Scenario 1
- Scenario 2

## Instructions

### Step 1: [First action]

Concrete explanation with example.

### Step 2: [Second action]

Concrete explanation with example.

## Examples

### Example 1: [Common scenario]

User says: "..."
Actions: ...
Result: ...

## Troubleshooting

### Error: [Common problem]
Cause: [Why]
Fix: [How]
```

3. Run `atris skill audit [name]` to validate
4. Run `atris update` to symlink to `.claude/skills/`

## Quality tiers

- **Bronze**: Passes all 12 mechanical checks from `atris skill audit`
- **Silver**: Bronze + good description + numbered steps + examples
- **Gold**: Silver + error handling + progressive disclosure + tested in production

Gold standard reference: `atris/skills/clawhub/atris/SKILL.md`

## Distribution checklist

Before publishing to ClawHub or sharing externally:

1. All 12 audit checks pass (`atris skill audit [name]`)
2. Description under 1024 chars, includes WHAT + WHEN + triggers
3. Version field set (semver)
4. Tags present (3-5 relevant tags)
5. No internal references (paths must be relative, no hardcoded project paths)
6. No README.md inside the skill folder
7. SKILL.md is self-contained or uses `references/` for supplementary docs
