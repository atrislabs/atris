# Atris Skills

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
| atris | Atris workflow enforcement + plan/do/review | `policies/ANTISLOP.md` |
| autopilot | PRD-driven autonomous execution - loops until done | — |
| email-agent | Gmail integration via AtrisOS - read, send, archive emails | — |
| meta | Metacognition for agents - how to think about thinking | `policies/LESSONS.md` |
| design | Frontend aesthetics - avoid generic AI look | `policies/atris-design.md` |
| backend | Backend architecture - prevent over-engineering | `policies/atris-backend.md` |
| writing | Essay process with approval gates | `policies/writing.md` |

## Creating Skills

1. Create `atris/skills/[name]/SKILL.md`
2. Create `atris/policies/[name].md`
3. Symlink: `cd .claude/skills && ln -s ../../atris/skills/[name] [name]`
