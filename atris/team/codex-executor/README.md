# Using the Codex Executor

Routes build steps to OpenAI Codex (ChatGPT plan, no API key) so Claude limits go to planning and review.

## One-time setup (per machine)

1. Install the Codex CLI and log in with ChatGPT:
   ```bash
   npm install -g @openai/codex
   codex login
   ```
2. Install the official plugin inside Claude Code (user scope — works in all projects):
   ```
   /plugin marketplace add openai/codex-plugin-cc
   /plugin install codex@openai-codex
   ```
3. Restart Claude Code (or `/reload-plugins`), then run `/codex:setup` — it must report ready.

## One-time setup (per project)

Copy this member folder into the project:
```bash
cp -r ~/arena/atris-cli/atris/team/codex-executor <project>/atris/team/
```

## Per session

1. Plan with Claude as usual (`atris plan`, or just describe the task).
2. For each mechanical build step, hand off to Codex:
   - In-session: `/codex:rescue <task with goal, write scope, validation command>`
   - Headless: `codex exec --cd "<workspace>" --sandbox workspace-write -c model_reasoning_effort=xhigh "<packet>"`
   - Packet template: `~/.claude/skills/claude-task/SKILL.md`
   - Run handoffs in the foreground — Claude Code's sandboxed/background shells block network, so `codex exec` fails there with DNS errors.
3. Review with Claude. **Always re-run the validation locally** — Codex's sandbox blocks localhost listeners and home-dir writes, so it reports false test failures.

## Keep with Claude (don't hand off)

Taste/judgment edits, secrets, releases, and steps where writing the packet costs more than the diff.
