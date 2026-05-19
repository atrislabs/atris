---
type: concept
slug: rebased-pack-co-first-loop
title: Rebased Pack Co First Loop
sources:
  - atris/context/_ingest/2026-05-19T03-50-onboarding/intake.md
  - atris/wiki/briefs/rebased-pack-co-starter-brief.md
last_compiled: 2026-05-19
last_verified: 2026-05-19
confidence: 0.74
dependencies:
  - atris/wiki/briefs/rebased-pack-co-starter-brief.md
  - atris/team/START_HERE.md
actionability: "Use this to run the first bounded Rebased Pack Co loop without treating local-only placeholder intake as real customer proof."
created: 2026-05-19
updated: 2026-05-19
tags:
  - business
  - loop
  - onboarding
---

# Rebased Pack Co First Loop

## Loop

```text
trigger -> received local business workspace
action  -> prove starter readiness, review queue clarity, and share handoff
reward  -> collaborator can start from one command packet without agent-only context
```

## Operator Run

1. Run `atris business start`.
2. Run `atris radar --json` and confirm there are no stale active missions.
3. Run `atris task reviews --limit 10` and confirm certified Review work stays human-gated.
4. Run `atris business share --write`.
5. Record the run with `atris business record atris/reports/2026-05-19-rebased-pack-co-first-loop-recap.md --outcome mixed --metric "starter readiness"`.

## Proof To Capture

- Business start shows the starter brief, first loop, one-pager, and team start guide.
- Radar shows no infinite-loop risk and no stale active mission.
- Review queue shows certified Review items with accept/revise commands.
- Share handoff writes a report file under `atris/reports/`.

## Stop Condition

Stop after the first proof recap is recorded and the share handoff names the next action.

## Guardrails

- Do not claim Rebased Pack Co is a real external customer until the operator supplies real evidence.
- Do not run external sends from this workspace without human approval.
- Do not accept Review items or mint AgentXP from agent-only proof.
