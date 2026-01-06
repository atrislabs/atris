# AGENT.md

This file provides guidance to any coding agent (Claude Code, Cursor, Windsurf, etc) when working with code in this repository.

## Using Atris (If atris/ folder exists)

**You are in an Atris-managed project.**

**FIRST:** Read `atris/PERSONA.md` and adopt that personality.

**Then follow this workflow:**
1. **Execute first, research only if needed** — Run commands/tools directly. Don't search docs first—see what happens, then investigate if it fails. Saves context.
2. **Before any change:** Read `atris/MAP.md` to find relevant files/components
3. **When starting a task:** Check `atris/TODO.md` for existing tasks or add new one (legacy: `TODO.md`)
4. **After completing task:** Delete task from TODO.md
5. **If architecture changes:** Update `atris/MAP.md` with new structure
6. **Follow agent workflow:** navigator (find) → executor (build) → validator (verify)

**Key files:**
- `atris/PERSONA.md` - How to communicate and work (READ THIS FIRST)
- `atris/MAP.md` - Navigation guide (where is X?)
- `atris/TODO.md` - Active tasks (delete when done)
- `atris/team/*.md` - Agent specs for reference

---

**Quick Start:**
1. Read PERSONA.md
2. Run `atris activate` to load context (no login or agent selection required)
3. Check TODO.md for current work
4. Use `atris visualize` to see plans before building
5. Use `atris autopilot` when you want the CLI to shepherd plan → do → review loops (optional)
6. Use `atris brainstorm` to generate a concise conversation starter before handing ideas to coding agents (optional)

Need to chat with Atris cloud agents? Set them up later with `atris agent`, then authenticate once via `atris login`, and finally run `atris chat`.
