# Atris Roadmap Notes

> Working notes for the phases referenced in `atris.md` (Phase 6). This file is intentionally lightweight and is meant for humans + agents to skim, not a full spec.

---

## Phase 5a — Sync

- **Goal:** Keep local markdown artifacts (`atris/` folder) in sync with the published `atris` package version.
- **Today:** `atris update` copies the latest `atris.md`, `GETTING_STARTED.md`, and agent templates into your project.
- **Later:** Add optional cloud sync so:
  - Local `logs/`, `MAP.md`, and `TODO.md` can be mirrored to a remote workspace.
  - Agents can collaborate asynchronously against the same journal + MAP.
  - Conflicts are resolved via markdown-aware merges (section-level, not whole-file overwrites).

---

## Phase 5b — Sessions

- **Idea:** Treat a work session as a first‑class object, defined entirely in markdown.
- **Mechanics (planned):**
  - Session files live under `atris/sessions/YYYY/MM-DD-[slug].md`.
  - Special tags like `!status`, `!result`, `!blocked`, `!decision` annotate key moments.
  - CLI helpers (e.g., `atris status`, future `atris session`) render these into a timeline / kanban view.
- **Why:** Makes it trivial for agents to reconstruct *how* a change happened, not just *what* changed.

---

## Phase 5c — Crew Orchestration

- **Goal:** Orchestrate a small crew of agents (navigator → executor → validator → launcher) from markdown config.
- **Config Sketch (not final):**

```markdown
atris/crew.yml
---
navigator: atris/agent_team/navigator.md
executor: atris/agent_team/executor.md
validator: atris/agent_team/validator.md
launcher: atris/agent_team/launcher.md

entry_workflow:
  - navigator: plan feature + update TODO.md
  - executor: build tasks
  - validator: test + update MAP.md
  - launcher: summarize + move journal items to Completed ✅
```

- **CLI integration (future):**
  - `atris crew plan|do|review|launch` as thin wrappers that feed the right spec + context to agents.
  - Optional cloud orchestration where crews can run unattended, reporting back via `logs/`.

---

## Implementation Notes

- These phases are **roadmap**, not hard requirements for using Atris today.
- The current CLI (`init`, `log`, `status`, `plan`, `do`, `review`, `analytics`, `update`, etc.) is stable even if these features evolve.
- When a roadmap item lands, it should:
  - Update `atris.md` + `Atris_NOTES.md` in the package.
  - Add or adjust the minimal number of CLI commands (no feature bloat).
  - Keep MAP/TASK_CONTEXTS/journal formats backward compatible wherever possible.


