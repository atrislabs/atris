# Atris Skills

Agent-agnostic skills. Works with Claude, Cursor, Codex, any LLM agent.

## Pattern

Every process = **Skill + Policy**

- `skills/[name]/SKILL.md`: How to DO (process)
- `policies/[name].md`: How to REVIEW (validation)

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

Each line says what the skill does and when to open it. A skill with a review policy names it after the link.

### Working in a workspace

- Find files through MAP.md, check tasks and answer where-is-X questions. Open [atris](atris/SKILL.md) when you start in an Atris repo. Policy: `policies/ANTISLOP.md`.
- Where the taste of the people you work for lives and how to keep it. Open [taste](taste/SKILL.md) before you make copy, pages, buttons or decks.
- Keep project memory as small linked notes: ingest, query, lint and reorganize. Open [wiki](wiki/SKILL.md) when you save knowledge or a note has grown too big.
- Search past journals and decisions. Open [memory](memory/SKILL.md) when someone asks what happened before or why.
- Clean stale docs, broken refs and abandoned tasks. Open [tidy](tidy/SKILL.md) when the workspace feels messy.
- A working method for daily-driver models. Open [fable-method](fable-method/SKILL.md) before a long multi-step task or when work feels shallow.
- Self-checks and how to split work across parallel members. Open [meta](meta/SKILL.md) when you are stuck or coordinating a team. Policy: `atris/lessons.md`.
- Turn a task into the deeper version a top professional would do. Open [ambitious](ambitious/SKILL.md) before you start a task that matters.

### Running the loop

- Run one plan, do and review tick on its own. Open [autopilot](autopilot/SKILL.md) when you should ship the next thing without asking.
- Schedule the recurring autopilot heartbeat. Open [loop](loop/SKILL.md) before you set up anything that fires on a timer.
- One verified, scored improvement tick with a receipt. Open [improve](improve/SKILL.md) when asked to make something better and prove it.
- A keep or revert experiment loop for experiment packs. Open [autoresearch](autoresearch/SKILL.md) when you tune a prompt or tool against a score.
- A long goal with a judge that fails today, a budget and seats. Open [campaigns](campaigns/SKILL.md) only when the path is unknown and takes many tries.
- Pick the next horizon and write the reverse path as tasks. Open [endgame](endgame/SKILL.md) when the queue is empty or direction is unclear.
- An all-day operating partner that tracks identity, goals and live status. Open [flow](flow/SKILL.md) at the start of a work session.
- Wake a member by name and run one closed tick. Open [wake](wake/SKILL.md) when someone says gm or wake up to a member.
- Send work to another terminal agent or engine profile. Open [engines](engines/SKILL.md) when a job should run on a different model or tool.
- Create and manage MEMBER.md team members. Open [create-member](create-member/SKILL.md) when you add a new role to the team.

### Making things

- Frontend rules that keep a screen from looking generated. Open [design](design/SKILL.md) when you build or review UI. Policy: `policies/atris-design.md`.
- Backend rules that keep code simple. Open [backend](backend/SKILL.md) when you build an API or service. Policy: `policies/atris-backend.md`.
- Essay process with gates. Open [writing](writing/SKILL.md) when you draft an essay or long post. Policy: `policies/writing.md`.
- Find and fix generated-sounding writing. Open [copy-editor](copy-editor/SKILL.md) when you edit a draft before it ships.
- Content written to get cited by AI answer engines. Open [aeo](aeo/SKILL.md) when a page should show up in AI answers.
- Write a release post. Open [launch](launch/SKILL.md) after a release ships.
- Author Atris block documents: docs, decks and reports. Open [blocks](blocks/SKILL.md) when you write a doc for the Atris editor.
- Build and deploy an Atris app from a description. Open [create-app](create-app/SKILL.md) when someone wants a new app or workflow.
- View, manage and trigger Atris apps. Open [apps](apps/SKILL.md) when asked about an existing app or its runs.
- Security reviews and full audits through the sentinel. Open [security-audit](security-audit/SKILL.md) when you review code for holes or triage a vulnerability.
- Audit and improve skills against the skill guide. Open [skill-improver](skill-improver/SKILL.md) when you create or fix a skill.

### Research and learning

- Research sweep across papers, code and the web. Open [research-search](research-search/SKILL.md) when you need the latest work on a topic.
- YouTube search, notes and learning. Open [youtube](youtube/SKILL.md) when you get a video link or need videos on a topic.
- Search posts on X. Open [x-search](x-search/SKILL.md) for social listening. It costs credits.

### Connected accounts

- Gmail: read, send and archive. Open [email-agent](email-agent/SKILL.md) when you handle email.
- Inbox triage that scores, drafts and archives. Open [magic-inbox](magic-inbox/SKILL.md) when asked to clear an inbox.
- Google Calendar. Open [calendar](calendar/SKILL.md) for schedules and meetings.
- Google Drive, Docs and Sheets. Open [drive](drive/SKILL.md) for files and spreadsheets.
- Google Slides. Open [slides](slides/SKILL.md) for decks.
- Slack. Open [slack](slack/SKILL.md) for team messages.
- Notion. Open [notion](notion/SKILL.md) for pages and databases.
- GitHub. Open [github](github/SKILL.md) for pull requests, issues and CI.
- Local macOS iMessage. Open [imessage](imessage/SKILL.md) to read or send texts from the Mac.
- Ramp card and spend. Open [ramp](ramp/SKILL.md) for expenses and burn.
- Render deploys and logs. Open [render-cli](render-cli/SKILL.md) for Render services.
- Quote a purchase or stock order that the person approves first. Open [commerce](commerce/SKILL.md) when asked to buy or trade.
- Submit and triage customer feedback. Open [atris-feedback](atris-feedback/SKILL.md) for the feedback queue.

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
