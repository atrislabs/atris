# atris

**atris** is an operating system for intelligence.

It turns any repo into an AI workspace with shared context, a `plan -> do -> review` loop, daily logs, feature packs, and reusable skills.

Atris gives every owner persistent AI computers.

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation loop
```

A computer can be personal or shared by a business. It can run a job like code, research, CRM, reporting, recruiting, event ops, support, or business ops.

## For Coding Agents

If you're an agent, run:

```bash
atris
```

If the prompt is vague or you do not know what to do next, run:

```bash
atris 0-shot
```

`atris zero-shot` and `atris next` are the same shortcut when you have no request typed.
For headless agents, use `atris zero-shot --json` or `atris next --json`. It returns the lane, horizon, model tier, first command, typed `routes.options[]`, a copy-pasteable `handoff.prompt`, and safe boundaries for the next move. Use `atris zero-shot --prompt` or `atris next --prompt` when you only want the handoff prompt. Use `atris zero-shot --write` or `atris next --write` to refresh `.atris/state/zero-shot.latest.json` and `.atris/state/zero-shot.prompt.txt` for ambient agent runtimes, then `atris zero-shot --check` or `atris next --check` to confirm those files are fresh.

Then read the workspace's `atris/atris.md` and follow it exactly. `atris.md` is the source of truth.

---

## What Atris Gives You

- An AI workspace on top of any repo
- Persistent AI computers for scoped jobs
- A local computer card that makes each workspace inspectable
- A strict `plan -> do -> review` loop
- Daily logs, task tracking, feature packs, and project memory
- Skills, team members, integrations, and cloud sync when you need them

## Critical Files

| File | Purpose |
|------|---------|
| `atris/atris.md` | Main instructions for agents working in this repo |
| `atris/MAP.md` | Navigation index with file:line refs |
| `atris/TODO.md` | Human-readable task view |
| `atris/logs/YYYY/YYYY-MM-DD.md` | Daily log, inbox, notes, completions |
| `atris/features/` | Feature packs with `idea.md`, `build.md`, `validate.md` |
| `atris/skills/` | Reusable skills for agents |
| `atris/team/` | Team member specs and local context |

```text
atris/
├── atris.md
├── MAP.md
├── TODO.md
├── logs/
├── features/
├── skills/
└── team/
```

## Install

```bash
npm install -g atris
atris --version
```

Requires Node.js 18+.
`atris task` uses built-in SQLite and requires Node.js 22+.

If you want Atris cloud workspaces, businesses, or integrations, run `atris setup` after install.

## How To Run Atris

```bash
cd your-project
atris init
atris
atris 0-shot
atris zero-shot
atris next
```

`atris init` scaffolds the workspace, including `atris/wiki/`. `atris` loads context and hands the workflow off to `atris/atris.md`.
`atris 0-shot`, `atris zero-shot`, and no-request `atris next` are the defaults when you do not know what to prompt next.
They route quick tasks, fast-model tasks, review work, mission verifier ticks, visible goal context, long-horizon planning, recovery work, owner-gated work, or no-current-task context checks.
Use `atris zero-shot --prompt` when you want a plain prompt to paste into another model.
Use `atris zero-shot --write` when a launcher or always-on agent should read the latest next move from `.atris/state/zero-shot.latest.json`.
Use `atris zero-shot --check` when an ambient agent needs to know whether the latest packet is fresh, stale, or missing.
`atris`, `atris atris.md`, `atris activate`, `atris member activate <name>`, and `atris brain activate` refresh that latest 0-shot state automatically.
Task commands that refresh `.atris/state/tasks.projection.json` also refresh the latest 0-shot state, so the route follows task queue changes.
Mission and Codex goal commands refresh it too, so long-running work can take over the next move when it becomes due.
`atris radar` also shows the current computed 0-shot route and durable prompt freshness status beside the live task, mission, worktree, and agent summary.
`atris status`, `atris status --quick`, and `atris status --json` include the current 0-shot route and first command beside the ordinary workspace health summary.
Generated `atris/now.md` includes the current 0-shot route and first command, so the first context file an agent reads has the same next move.

If you're still shaping the idea, use `atris brainstorm`. If you want Atris to keep cycling, use `atris run` or `atris autopilot`. If you want project memory checked for stale pages and missing context, use `atris loop`. `atris activate` surfaces wiki state from `atris/wiki/STATUS.md` when it exists.

Core loop: `plan` -> `do` -> `review`

Integrates with any agent.

## Chat With Atris 2

`ax` is the local Atris 2 coding-agent CLI. It talks to the AtrisOS backend at `http://127.0.0.1:8000/api/atris2/turn`, streams text, shows tool activity, and sends the current folder as the workspace.

```bash
cd your-project
ax --pro "find the task system and explain it"
ax --fast "what files are here?"
ax --pro --chat
ax --doctor
```

Use Pro for agentic file work and edit/test loops. Use Fast for quick workspace search, short chats, and small edits.

## Play AgentXP

AgentXP is the proof-backed game loop for getting better with agents. Start it
inside any project folder:

```bash
npm exec --yes --package atris@latest -- atris play
```

The first run creates a local starter mission if one does not exist. The loop is:

```text
start -> proof -> accept -> login -> sync
```

The player path:

```bash
atris play
atris task claim <mission-ref> --as game-manager
atris task ready <mission-ref> --as game-manager --proof "<artifact path + verifier result>"
atris task accept <mission-ref> --as justin --proof "<human review>"
atris xp card --local
atris login
atris xp sync --local
```

The manager path:

```bash
atris gm --player justin
```

No proof, no AgentXP. `atris task done --proof` records review/RL context, but
only human `atris task accept` mints Career XP for the local card or hosted
leaderboard.

## Business Owners

If you want a shared owner for a company, lab, collective, community, artist, team, or project, use the business command instead of raw `atris init`.

```bash
atris business init "BLOND:ISH" --owner-email joel@blondish.world
cd ~/arena/atris-business/blondish
atris business onboard --website https://blondish.world --contact "Joel Zimmerman" --note "artist-led brand and ticket sales"
atris align --fix
```

That creates the shared owner, creates its first/default computer, writes `.atris/business.json`, initializes `.atris/state/` for events and run history, and scaffolds the local `atris/` workspace under `~/arena/atris-business/<slug>/` with starter roles, a default recap template, and an initial task queue in `atris/TODO.md`.

If you do not have a neat source pack yet, `atris business onboard` is the easiest intake step: give it a website, a named human, a few notes, or run it in a folder with loose files. Atris turns that into raw intake, a starter brief, a first workflow, a safe next action, and a short operator brief.

Use the owner's language when you talk about it:

```text
Your business runs on Atris.
Your lab runs on Atris.
Your collective runs on Atris.
```

You can also use bare input:

```bash
atris business onboard https://example.com "founder-led b2b ops" ./notes.md
```

If you already have a folder full of source material, run it from there with `atris business init "BLOND:ISH" --here`.

When the first recap is done, record it into the RL state logs:

```bash
atris business record atris/reports/2026-04-12-operator-recap.md --outcome mixed --metric "operator speed"
```

## Core Commands

| Command | Purpose |
|---------|---------|
| `atris` | Load context and start |
| `atris 0-shot` | Pick the next safe move when you do not know what to prompt |
| `atris init` | Scaffold an Atris workspace |
| `atris brainstorm` | Explore before planning |
| `atris plan` | Create the plan/spec |
| `atris do` | Execute work |
| `atris review` | Validate work and capture learnings |
| `atris run` | Auto-chain `plan -> do -> review` |
| `atris autopilot` | Guided loop with approvals |
| `atris log` | Add inbox items to today's journal |
| `atris status` | Show active work, completions, and current 0-shot route |
| `atris task` | Durable local task state with claims, dialogue, review episodes, JSON export, TODO import, TODO render, board, and sync dry-run |
| `atris play` | Enter the AgentXP player loop for one proof-backed mission |
| `atris gm` | Enter AgentXP General Manager mode for player missions and review queues |
| `atris xp` | Show the local AgentXP card and sync eligible proof to the hosted leaderboard |
| `atris codex-goal` | Inspect or clear a completed native Codex thread goal after writing a backup, row dump, and receipt |
| `atris learn` | Manage structured learnings |
| `atris ingest` | Stage raw evidence into `atris/context/` and compile into `atris/wiki/` |
| `atris loop` | Refresh wiki health, stale/orphan signals, and next ingest candidates |
| `atris wiki` | Full wiki namespace: ingest, query, lint, search, log, and loop |
| `atris receipt` | Save evidence from an agent run |
| `atris experiments` | Run small experiments and compare results |
| `atris computer card` | Show or write the local owner/computer card |

## Built-In Systems

- `atris learn` stores structured project memory in `atris/learnings.jsonl`
- `atris wiki` keeps repo memory in `atris/wiki/` by default, with `--cloud` when you want the remote workspace path
- `atris ingest` now stages local source packs under `atris/context/_ingest/`, writes a manifest receipt, and refreshes `atris/wiki/STATUS.md` plus `log.md`
- `atris wiki --private` stores local-only sensitive notes under `.atris/presidio/`
- `atris loop` refreshes `atris/wiki/STATUS.md` and `atris/wiki/log.md`, flags stale/orphan pages, and suggests the next ingest
- `atris activate` loads the current wiki status so the next session starts with project memory, not just tasks
- `atris member` keeps team-member identity and learning local-first: `MEMBER.md` is the role contract, `goals.json` is the machine-readable goal/experiment state, `goals.md` is the human readout, and `logs/YYYY-MM-DD.md` records what happened. Use `atris member goal`, `tick`, `status`, `block`, and `review --value 1..5` to test whether a member is making useful progress or needs the operator/orchestrator.
- `atris codex-goal` is the guarded bridge for native Codex `/goal`: `status` reads `~/.codex/state_5.sqlite`, while `reset --thread <id> --confirm-complete-goal-reset` backs up the DB, dumps the exact completed `thread_goals` row, deletes only that completed row, and writes a receipt. The next native goal must still be created by the live Codex thread; Atris Mission/member goals remain the durable loop state.
- `atris task` keeps durable local task state and append-only events for agents while `atris/TODO.md` remains a readable regenerated project board. Human views use semantic refs like `OBL-18`; commands accept `OBL-18`, `OBL18`, full 26-char task IDs, or any unique legacy prefix, while JSON/API keep the full `id` canonical and expose `display_id` plus `legacy_ref`. Use `atris task new`, `atris task delegate "..." --to <owner>`, `atris task day`, `atris task next`, `atris task say`, and `atris task ready <id> --proof "..."` for the agent loop; once proof is in Review, run `atris task review-chat <id> --as codex-review` to append a task-owned `/codex` verification prompt. Human approval uses `atris task accept <id>` to move the task to Done and award Career XP, and `atris task revise <id> --note "..."` sends work back to Do. Add `--json` for headless agents. Use `atris task serve` to open the local Task Factory board with goals, work streams, lineage, proof, lessons, and the compounding chain. Every change refreshes compact `.atris/state/tasks.projection.json` for web/desktop; use `atris task show <ref>` or `atris task events --all` for the full ledger. Use `atris task sync --dry-run` to preview the canonical Supabase/Swarlo task writes before any cloud mutation. Use `--via swarlo` on delegation when the live coordination layer should claim/report from the same task record. Use `--create-next` with review/finish to turn a `--next` suggestion into the next durable task. Use `atris task setup --import-todo` to bootstrap, `atris task review` to write an RSI episode, and `atris task render` to rebuild markdown if it gets clobbered. In cloud business workspaces, Supabase `tasks` is the source of truth and Swarlo is the live claim/report layer.
- `atris experiments` runs small test packs in `atris/experiments/`
- `atris pull` and `atris push` sync cloud workspaces and journals
- `atris live` keeps a business brain fresh by checking/fixing the workspace, pushing local state, pulling cloud state, and pushing again after local changes go quiet

## Verifiable Feedback Loop

Under the hood, Atris can keep score on real repo work.

- Tasks can carry a `Verify:` command, so work can end on a deterministic check instead of pure prose.
- Plan, do, and review now carry the same Confidence Gate: find every plausible loophole, patch it with source/proof/verifier/owner/rollback, or name it as residual risk before advancing.
- `atris autopilot` can run that check after review and record the result in the journal.
- Future task picks can use recent results, so Atris learns from repo-local history without claiming model retraining.

## Benchmark Harness

Atris ships one public head-to-head benchmark harness for comparing a pinned
single-model baseline against a coordinated stack run on the same task brief.

Quickstart:

```bash
node bin/atris.js experiments validate endstate-baseline
node bin/atris.js experiments validate endstate-stack
node bin/atris.js experiments run endstate-baseline --dry-run
node bin/atris.js experiments run endstate-stack --dry-run
node bin/atris.js experiments compare endstate
```

One-command rehearsal:

```bash
node bin/atris.js experiments replay endstate
```

What to inspect:

- receipts land in `atris/experiments/endstate-baseline/artifacts/` and
  `atris/experiments/endstate-stack/artifacts/`
- scores append to each pack's `results.tsv`
- `atris experiments compare endstate` prints the latest side-by-side comparison
- `atris experiments replay endstate` runs the full public dry-run rehearsal
- the benchmark contract lives at `atris/features/endstate/contract.md`
- the verification log lives at `atris/features/endstate/validate.md`

The stack wins Level 1 only if it beats the baseline on total score and does
not lose the reviewed completion category.

## Skills

Atris ships a real skill catalog in `atris/skills/`, not just one workflow file.

Examples:
- `atris`, `autopilot`, `autoresearch`, `wiki`, `loop`
- `backend`, `design`, `copy-editor`, `meta`, `writing`
- `github`, `email-agent`, `calendar`, `drive`, `slack`, `notion`, `slides`, `x-search`, `youtube`, `ramp`
- `apps`, `create-app`, `create-member`, `memory`, `magic-inbox`, `improve`, `skill-improver`, `flow`

```bash
atris skill list
atris skill audit [name]
atris skill fix [name]
atris skill create <name>
atris skill link [--all]
```

For Codex, copy any skill folder into `~/.codex/skills/`.

## v3.2.0

- **Staleness gate** — tasks tagged `[unverified]` are skipped at the moment of use, not pruned eagerly. Three-state model: actionable / unverified / deleted.
- **Lesson gate** — `isLessonResolved` checks whether a lesson already shipped before proposing new work from it. Prevents the loop from re-solving solved problems.
- **`atris release`** — new command: tags the version, bumps package.json, creates a GitHub release, and drafts a `/launch` post in one shot.
- **Shell injection fix** — `checkStaleness` switched from `execSync` string interpolation to `execFileSync` with args arrays. Markdown-derived content (task titles, inbox items) no longer reaches a shell.
- **Codex hardening** — `atris activate` and `atris` entry point detect Codex environments and write `AGENTS.md` so Codex sessions start with workspace context.

## Update

```bash
atris upgrade     # Install latest from npm
atris update      # Sync local workspace files to new version
```

---

**License:** MIT | **Repo:** [github.com/atrislabs/atris](https://github.com/atrislabs/atris.git)
