# Atris Skills

Agent-agnostic skills. Works with Claude, Cursor, Codex, any LLM agent.

## Pattern

Every process = **Skill + Policy**

- `skills/[name]/SKILL.md` — How to DO (process)
- `policies/[name].md` — How to REVIEW (validation)

## Integration

### Claude Code
```bash
cd .claude/skills && ln -s ../../atris/skills/[name] [name]
```

### Codex
```bash
cp -r atris/skills/[name] ~/.codex/skills/
```

## Available Skills

| Skill | Description | Policy |
|-------|-------------|--------|
| atris | Workflow enforcement + plan/do/review | `policies/ANTISLOP.md` |
| autopilot | PRD-driven autonomous execution | — |
| backend | Backend architecture anti-patterns | `policies/atris-backend.md` |
| design | Frontend aesthetics policy | `policies/atris-design.md` |
| email-agent | Gmail integration via AtrisOS | — |
| memory | Context and memory management | — |
| meta | Metacognition for agents | `policies/LESSONS.md` |
| writing | Essay process with gates | `policies/writing.md` |
| copy-editor | Detects and fixes AI writing patterns | - |

## ClawHub (External Distribution)

Skills we publish to OpenClaw's ClawHub marketplace. These have YAML frontmatter and are formatted for external agents.

| Skill | Description | Status |
|-------|-------------|--------|
| clawhub/atris | Codebase intelligence — MAP.md navigation for any agent | Ready to publish |

```bash
# Publish to ClawHub
clawhub publish atris/skills/clawhub/atris --slug atris --name "Atris" --version 1.0.0
```

## Creating Skills

1. Create `atris/skills/[name]/SKILL.md`
2. Create `atris/policies/[name].md` (optional)
3. Install to your agent (see Integration above)
4. For external distribution, put in `atris/skills/clawhub/[name]/`
