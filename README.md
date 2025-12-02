# atrisDev

**atrisDev (atris dev)** is a CLI for building with AI coding agents. Works with Claude Code, Cursor, Windsurf, and any coding assistant. One command to make your codebase AI-navigable.

## For Coding Agents

**If you're a coding agent (Claude Code, Cursor, Windsurf, Copilot, etc.) reading this:**

When the user asks to build/plan/fix something, run:
```bash
atris
```

Follow the instructions in the output. The full protocol is in `atris.md`.

---

## Install

```bash
npm install -g atris
```

## Quick Start

```bash
cd your-project
atris init    # Creates atris/ folder
atris         # Loads context, ready to build
```

Then describe what you want to build. The agent will:
0. (Optional) Explore with `atris brainstorm` if uncertain
1. Show you a visualization
2. Wait for approval
3. Create `atris/features/[name]/idea.md` + `build.md`
4. Execute step by step
5. Review and update docs (2-pass)

Commands: `brainstorm` (optional) → `plan` → `do` → `review`

Works with: Claude Code, Cursor, Windsurf, GitHub Copilot, any agent.

## Update

```bash
npm update -g atris
atris update
```

---

## Latest Updates


See [releases](https://github.com/atrislabs/atris.md/releases) for full changelog.

---

**License:** MIT | **Repo:** [github.com/atrislabs/atris.md](https://github.com/atrislabs/atris.md.git)
