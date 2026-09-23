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
| aeo | Content engineered to get cited by ChatGPT, Claude, and Gemini | - |
| apps | View, manage, and trigger Atris apps | - |
| atris | Workspace navigation, tasks, MAP.md, where-is-X questions | `policies/ANTISLOP.md` |
| atris-feedback | Submit, list, resolve, close, or delete customer feedback | - |
| autopilot | Run one autonomous plan/do/review tick | - |
| autoresearch | Keep/revert experiment loop for experiment packs | - |
| backend | Backend architecture policy | `policies/atris-backend.md` |
| blocks | Author Atris block documents: docs, decks, reports | - |
| calendar | Google Calendar via AtrisOS API | - |
| copy-editor | Detects and fixes AI writing patterns | - |
| create-app | Build and deploy an Atris app from a description | - |
| create-member | Create and manage MEMBER.md team members | - |
| design | Frontend aesthetics policy | `policies/atris-design.md` |
| drive | Google Drive, Docs, and Sheets via AtrisOS API | - |
| email-agent | Gmail via AtrisOS API | - |
| endgame | Pick the next horizon and write the reverse path as tasks | - |
| engines | Dispatch work to an installed terminal agent or engine profile | - |
| fable-method | Working method for daily-driver models | - |
| flow | All-day operating partner: identity, goals, live status | - |
| github | GitHub via AtrisOS API | - |
| imessage | Inspect and send local macOS iMessage | - |
| improve | One verified, scored improvement tick with a receipt | - |
| launch | Write a release post for Twitter and LinkedIn | - |
| loop | Schedule the recurring autopilot heartbeat | - |
| magic-inbox | Autonomous inbox triage, drafts, and archive | - |
| memory | Search and reason over journal history | - |
| meta | Metacognition for agents | `atris/lessons.md` |
| notion | Notion via AtrisOS API | - |
| ramp | Ramp card and spend management | - |
| render-cli | Render.com CLI inspect, auth, and deploys | - |
| research-search | Research sweep across arxiv, semantic scholar, github, web | - |
| skill-improver | Audit and improve skills against the Anthropic guide | - |
| slack | Slack via AtrisOS API | - |
| slides | Google Slides via AtrisOS API | - |
| tidy | Workspace maintenance: stale docs, broken refs, abandoned tasks | - |
| wake | Wake a member and run one closed-loop tick | - |
| wiki | Local-first project wiki: ingest, query, lint | - |
| writing | Essay process with gates | `policies/writing.md` |
| x-search | X/Twitter search via xAI Grok API | - |
| youtube | YouTube discovery, notes, and learning | - |

## ClawHub (External Distribution)

Skills we publish to OpenClaw's ClawHub marketplace. These have YAML frontmatter and are formatted for external agents.

| Skill | Description | Status |
|-------|-------------|--------|
| clawhub/atris | Codebase intelligence: MAP.md navigation for any agent | Ready to publish |
| clawhub/chief-of-staff | Daily briefing agent that learns your patterns | Ready to publish |
| clawhub/member-runtime | Load and run MEMBER.md team members | Ready to publish |
| clawhub/philosophy-of-work | Agent onboarding: philosophy, 60s start, proof contract | Ready to publish |

```bash
# Publish to ClawHub
clawhub publish atris/skills/clawhub/atris --slug atris --name "Atris" --version 1.0.0
```

## Managing Skills

```bash
atris skill list              # Show all skills with compliance status
atris skill audit [name|--all]  # Validate against Anthropic skill guide
atris skill fix [name|--all]    # Auto-fix common issues
```

## Creating Skills

1. Create `atris/skills/[name]/SKILL.md`
2. Run `atris skill audit [name]` to validate
3. Create `atris/policies/[name].md` (optional)
4. Install to your agent (see Integration above)
5. For external distribution, put in `atris/skills/clawhub/[name]/`
