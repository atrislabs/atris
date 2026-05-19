# Rebased Pack Co Share Handoff

For: collaborator
Role: collaborator
Business: Rebased Pack Co (rebased-pack-co)
Business ID: local-only
Workspace ID: local-only
Local path: /Users/keshavrao/arena/atris-cli
Ready to share: yes
Remote pull: local-only

## Get The Workspace

If this folder is already on your machine:

```bash
cd /Users/keshavrao/arena/atris-cli
atris business start
```

Remote pull is not available yet:

- This workspace is local-only because it is missing a cloud business ID or workspace ID.
- Share the folder directly, or create/pull the cloud business workspace before sending this handoff.

## Start Here

```bash
cd /Users/keshavrao/arena/atris-cli
atris
atris business start
atris radar
atris task next
atris member activate operator
atris mission status --status active --json
# If no active mission exists:
atris mission start "Run the first useful loop for Rebased Pack Co" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"
atris member goal-from-mission operator
```

## What To Read

- Map: atris/MAP.md
- Queue: atris/TODO.md
- Agent adapters: AGENTS.md, CLAUDE.md, GEMINI.md
- Team start: atris/team/START_HERE.md
- Starter brief: atris/wiki/briefs/rebased-pack-co-starter-brief.md
- First loop: atris/wiki/concepts/rebased-pack-co-first-loop.md
- Operator one-pager: atris/reports/2026-05-19-rebased-pack-co-operator-one-pager.md

## First Useful Loop

```bash
atris business onboard --website <url> --contact "Name" --note "what changed"
atris pull --dry-run
atris task next
atris mission status --status active --json
# If no active mission exists:
atris mission start "Run the first useful loop for Rebased Pack Co" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"
atris member goal-from-mission operator
atris do
atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"
atris business share --write
atris align --fix
```

## Proof State

- Team lanes: 9
- Onboarding packs: 1
- Reports: 5
- Events: 1
- Episodes: 1
- Scorecards: 1

## Atris OS State

- Tasks: 0 open, 1 claimed, 37 review (37 certified), 0 blocked
- Missions: 0 active, 0 running, 0 always-on, 0 stale/no-verifier
- Team goals: 9 member lanes, 1 with active goals
- AgentXP: 29 total, 0 today, 29 receipts, integrity verified
- Loop: 22 mission ticks; Codex goal none
- XP gate: proof can move to Review; XP lands only after human accept

Useful commands:

```bash
atris radar
atris task next
atris mission status --status active --json
# If no active mission exists:
atris mission start "Run the first useful loop for Rebased Pack Co" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"
atris member goal-from-mission operator
atris xp status --local --json
```

## Next Action

- Start from the first loop, ship one small artifact, then record the recap.

## Guardrails

- Do not mix another business into this workspace.
- No external sends without operator approval.
- No XP until proof is accepted by a human.
