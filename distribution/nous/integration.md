# Atris for Hermes Agents

Atris is an open-source operating system for agent work. Drop an `atris/` folder in a repo and it becomes the on-disk brain for that workspace: instructions, navigation, tasks, logs, skills, wiki state, and proof that the next agent can read without depending on chat history.

## What A Hermes Agent Gets

- `atris/MAP.md` gives file:line navigation, so the agent checks the map before re-scanning the repo.
- `atris task` gives a durable task ledger with claims, review state, proof text, and a local projection at `.atris/state/tasks.projection.json`.
- `atris mission` gives a goal loop with owner, verifier, tick, complete, and receipt state for work that must survive a single session.
- `atris worktree` gives isolated Git worktrees for parallel agents, with guarded start, ship, status, and cleanup commands.
- `atris land` shows work still in the air and supports `--reap --dry-run` so autonomous branches merge or get cleared with backup.

## Install

In any repo:

```bash
npx -y atris init
```

For Hermes setups that install skills, use the Atris skill from ClawHub or the atrislabs Hermes tap, then run the same CLI commands inside the target repo.

## Minimal First Session

```bash
npx -y atris init
```
Scaffold `atris/`, `atris/MAP.md`, `atris/TODO.md`, logs, wiki state, team files, and agent adapters.

```bash
atris activate
```
Load workspace context, recent completions, TODO, MAP, journal, and wiki status.

```bash
atris task new "Add README proof line so Hermes reviewers can verify the demo"
```
Create a local task. The command prints a display id such as `ABC-1`.

```bash
atris task claim <id> --as hermes-agent
```
Claim the task before editing so another agent can see ownership.

```bash
atris task ready <id> --proof '[verified] `grep -q "Demo proof line" README.md` passed (exit 0); README.md contains the demo line.'
```
Move the task to review with concrete proof. Human acceptance remains a separate gate.

```bash
atris recap
```
Summarize what changed, how it was checked, and what still needs human review.

## Longer Runs

Use `atris mission start "objective" --owner hermes-agent --verify "npm test"` when the work should keep state across ticks.
Use `atris worktree start --member hermes-agent --task "small task" --claim` when parallel agents need isolated checkouts.
Use `atris land` before stopping, and `atris land --reap --dry-run` to preview stale work cleanup.

Links: [github.com/atrislabs/atris](https://github.com/atrislabs/atris) | [npm atris](https://www.npmjs.com/package/atris)
