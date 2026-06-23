---
name: wake
description: "Wake a team member by name — use gm [member] or wake up [member] — and run ONE closed-loop tick: boot, inbox, claim, one bounded slice, verify, commit+push, proof, receipt. Optionally dispatch the build to an engine (codex/cursor/devin). Triggers on: gm, good morning, wake up [member], wake the team, run a tick as [member]."
version: 1.0.0
tags:
  - wake
  - team
  - members
  - closed-loop
  - autonomous-org
---

# Wake — one tick of a team member

"gm [member]" means: that member does one real unit of work, end to end, with proof. No status theater. If there is nothing real to do, say so and stop.

## Resolving the member

Look for `atris/team/{member}/` (or `team/{member}/`) in the current repo. If the member has a `WAKE.md`, follow it exactly — it overrides this skill. If not, run the default tick below and offer to write a `WAKE.md` from it.

Wake-enabled lanes as of 2026-06-12: `neo` (atrisos-backend), `frontend-core-systems` (atrisos-web), `ios-engineer` (terrace), `mission-lead` (project-obelisk).

## The tick

1. **Boot** — read `MEMBER.md`, `goals.md`, latest log in `logs/`, and `atris/MAP.md`.
2. **Inbox** — today's log (`atris/logs/{year}/{date}.md`) section `## Feedback inbox`: promote bullets to the plane (`atris task add --tag {product}`), delete promoted bullets.
3. **Claim** — `atris task queue`; claim the top unclaimed task `--as {member}`. Claimed by someone else → skip, no quick fixes. Nothing unclaimed → find ONE small genuine defect/improvement, add it to the plane, claim that.
4. **Work** — ONE bounded slice. `git status` first; stage only own files; never destructive git; branch or worktree on shared checkouts. Build-heavy slice? Dispatch to an engine via the `engines` skill — the member still owns verification and the receipt.
5. **Verify** — run the relevant build/tests. Evidence carries a timestamp.
6. **Ship** — commit and PUSH to GitHub (at minimum once per completed slice). Then `atris task ready {id} --proof "{evidence}"`.
7. **Receipt** — one line in today's log. Blocked on a human → `waiting-on-human` task ("WAITING ON {who}: {exact action}"). Nothing to do → say so and end quietly.

## Hard rules

- Only members claim; visiting agents may add/say/delegate, never claim.
- Human acceptance (`atris task accept*`) is human-only — the CLI enforces it; never spoof agent detection to get past it.
- One tick per wake. The loop's value is the receipt trail, not the volume.
