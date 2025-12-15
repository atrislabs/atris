# ATRIS Skills

Agent-agnostic skills. Works with Claude, Cursor, Codex, any LLM agent.

## Pattern

Every process = **Skill + Policy**

- `skills/[name]/SKILL.md` — How to DO (process)
- `policies/[name].md` — How to REVIEW (validation)

## Claude Integration

Skills auto-detect via symlinks:

```
atris/skills/writing/SKILL.md     ← source of truth
         ↑
.claude/skills/writing/           ← symlink
```

## Available Skills

| Skill | Description | Policy |
|-------|-------------|--------|
| writing | Essay process with approval gates | `policies/writing.md` |

## Creating Skills

1. Create `atris/skills/[name]/SKILL.md`
2. Create `atris/policies/[name].md`
3. Symlink: `cd .claude/skills && ln -s ../../atris/skills/[name] [name]`
