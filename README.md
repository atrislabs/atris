# atris

**atris** is an operating system for AI work. It turns any repo into a workspace an agent can actually operate: shared context it reads before it acts, a `plan -> do -> review` loop, durable tasks and daily logs, and verification that ends work on a real check instead of a promise.

Every owner gets persistent computers to run it:

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

Then read the workspace's `atris/atris.md` and follow it exactly. `atris.md` is the source of truth.

---

## What Atris Gives You

- An AI workspace on top of any repo
- Persistent AI computers for scoped jobs
- A local computer card that makes each workspace inspectable
- A strict `plan -> do -> review` loop
- Daily logs, task tracking, feature packs, and project memory
- Skills, team members, integrations, and cloud sync when you need them
- A plain-English answer to "what did my AI actually do?" — run `atris recap` (add `--share` for a paste-ready summary backed by receipts)

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
```

`atris init` scaffolds the workspace, including `atris/wiki/`. `atris` loads context and hands the workflow off to `atris/atris.md`.

If you're still shaping the idea, use `atris brainstorm`. If you want Atris to keep cycling, use `atris run` or `atris autopilot`. If you want project memory checked for stale pages and missing context, use `atris loop`. `atris activate` surfaces wiki state from `atris/wiki/STATUS.md` when it exists.

Core loop: `plan` -> `do` -> `review`

Integrates with any agent.

## Chat With Atris 2

`ax` is the Atris 2 chat and coding-agent CLI. It uses the hosted Atris cloud by default, streams text, shows tool activity, and keeps fresh installs away from local setup.

```bash
cd your-project
ax chat ax --fast
ax --fast "hello"
ax --pro "help me plan this task"
ax --max "reason through this hard decision"
ax --doctor
```

Use Fast for quick chat and low-latency Atris loops. Use Pro for deeper tool loops. Use Max for the hardest jobs — it runs the highest-reasoning model and takes longer per turn. Advanced local workspace mode is opt-in with `--local` plus `AX_BACKEND_URL`.

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
| `atris init` | Scaffold an Atris workspace |
| `atris brainstorm` | Explore before planning |
| `atris plan` | Create the plan/spec |
| `atris do` | Execute work |
| `atris review` | Validate work and capture learnings |
| `atris run` | Auto-chain `plan -> do -> review` |
| `atris run logs` | Browse glass run logs (phase reasoning persisted to disk) |
| `atris run prune-logs` | Prune old run logs, keeping only the most recent N |
| `atris run search` | Search phase reasoning across all run logs by keyword |
| `atris run stats` | Show run log stats: phase counts, avg durations |
| `atris run export` | Export all run logs as a JSON bundle |
| `atris run diff` | Compare two run logs side by side |
| `atris autopilot` | Guided loop with approvals |
| `atris pulse` | Install or run the durable overnight heartbeat |
| `atris log` | Add inbox items to today's journal |
| `atris now` | Show the current operating truth |
| `atris radar` | Show live agents joined with tasks, missions, and worktrees |
| `atris ctop` | Show process-first live agent CPU and memory |
| `atris status` | Show active work and completions |
| `atris task` | Durable local task state and the agent work loop |
| `atris mission` | Durable goal, owner, verifier, tick receipts, and loop state |
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
| `atris release` | Draft or publish a version bump, tag, GitHub release, and launch post |

## Built-In Systems

- `atris learn` stores structured project memory in `atris/learnings.jsonl`
- `atris wiki` keeps repo memory in `atris/wiki/` by default, with `--cloud` when you want the remote workspace path
- `atris ingest` now stages local source packs under `atris/context/_ingest/`, writes a manifest receipt, and refreshes `atris/wiki/STATUS.md` plus `log.md`
- `atris wiki --private` stores local-only sensitive notes under `.atris/presidio/`
- `atris loop` refreshes `atris/wiki/STATUS.md` and `atris/wiki/log.md`, flags stale/orphan pages, and suggests the next ingest
- `atris activate` loads the current wiki status so the next session starts with project memory, not just tasks
- `atris member` keeps team-member identity and learning local-first: `MEMBER.md` is the role contract, `goals.json` is the machine-readable goal/experiment state, `goals.md` is the human readout, and `logs/YYYY-MM-DD.md` records what happened. Use `atris member goal`, `tick`, `status`, `block`, and `review --value 1..5` to test whether a member is making useful progress or needs the operator/orchestrator.
- `atris codex-goal` is the guarded bridge for native Codex `/goal`: `status` reads `~/.codex/state_5.sqlite`, while `reset --thread <id> --confirm-complete-goal-reset` backs up the DB, dumps the exact completed `thread_goals` row, deletes only that completed row, and writes a receipt. The next native goal must still be created by the live Codex thread; Atris Mission/member goals remain the durable loop state.
- `atris task` keeps durable local task state and append-only events for agents; `atris/TODO.md` is just a regenerated readable board. Run the loop with `atris task new`, `delegate "..." --to <owner>`, `next`, `say`, and `ready <id> --proof "..."`; human approval is `atris task accept <id>` (moves to Done, awards Career XP) or `revise <id> --note "..."`. Final task transitions also append the general daily log and, when a real `atris/team/<member>/MEMBER.md` matches the task owner, that member's daily log. Add `--json` for headless agents, `atris task serve` for the local board, and `atris task show <ref>` / `events --all` for the full ledger. Commands accept semantic refs (`OBL-18`), full IDs, or any unique prefix. In cloud business workspaces, Supabase `tasks` is the source of truth and Swarlo the live claim layer.
- `atris mission` is the durable autonomy layer: start with an owner, verifier, runner, and stop condition; record bounded work with `mission tick`; close with `mission complete` only after proof. Runners include `manual`, `claude`, `atris2`, and `codex_goal`.
- `atris pulse` is the OS-cron heartbeat for overnight self-improvement. Use `atris pulse status`, `tick`, `run`, `install --cadence "<cron>" --days 7 --verify "npm test" --model opus`, and `uninstall`.
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

## Before a New Version

Run the release-facing checks before bumping:

```bash
node bin/atris.js --help
node bin/atris.js pulse --help
node bin/atris.js release --help
node --test
```

Then dry-run the release:

```bash
atris release --dry-run
```

`atris release` drafts or publishes from local git history. `--dry-run` prints the planned bump without committing, tagging, or pushing.

## Update

```bash
atris upgrade     # Install latest from npm
atris update      # Sync local workspace files to new version
```

---

**License:** MIT | **Repo:** [github.com/atrislabs/atris](https://github.com/atrislabs/atris.git)
