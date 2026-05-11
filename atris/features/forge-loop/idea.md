# Forge Loop — always-on agent workspace

> **Status:** planning
> **Created:** 2026-04-15
> **Last Updated:** 2026-04-15

---

## Problem Statement

Improvement work happens only when a human kicks it off. Backlogs rot, MAP.md drifts, secrets stay un-rotated, small bugs ship to users. The CodeOps EC2 sandbox already exists in `atrisos-backend` and ships PRs autonomously — but it only fires reactively (on errors) against one repo (atrisos-backend hardcoded).

---

## Solution Design

Make CodeOps proactive and multi-repo. A 20-minute cron picks the highest-weight work item across all registered repos, dispatches `improve_pipeline` against it, scores the outcome (CI pass / merge / revert) into a DynamoDB scorecard, and feeds revert-rate back into source weights so the loop gets smarter. atris-cli is the first non-backend repo in the registry, gated by `scripts/smoke.sh` as the CI scorecard.

---

## ASCII Visualization

```
          ┌────────────── /forge tick (every 20m) ──────────────┐
          │                                                      │
Render    │  1. FETCH work pool (union across all repos)         │
 Cron ───▶│     errors • failing CI • TODO.md • inbox •          │
          │     lessons.md • open issues • stale env • MAP drift │
          │                                                      │
          │  2. PICK highest weight  (decay by attempts)         │
          │                                                      │
          │  3. DISPATCH improve_pipeline(idea, repo)            │
          │                       │                              │
          │                       ▼                              │
          │            CodeOps EC2 (i-02fc25b8cba674d06)         │
          │            /workspace/<repo>/  ← git pull every 10m  │
          │            Claude Code CLI (Opus) builds, tests      │
          │                       │                              │
          │                       ▼                              │
          │            Codex review → gh pr create → CI poll     │
          │                       │                              │
          │                       ▼                              │
          │  4. SCORE  CI pass? merged? reverted in 24h?         │
          │            → DynamoDB atris_ticks                    │
          │                                                      │
          │  5. LEARN  append outcome to <repo>/atris/lessons.md │
          │            re-weight sources by merge_rate           │
          └──────────────────────────────────────────────────────┘
```

---

## Success Criteria

- [ ] `scripts/smoke.sh` exists and is the CI gate (PASS on master, FAIL on regressions). **Done in tick 1.**
- [ ] `.github/workflows/smoke.yml` runs smoke on every PR + push. **Tick 2 — blocked on `gh auth refresh -s workflow`.**
- [ ] `improve_pipeline` accepts a `repo` arg (default = current behavior, atrisos-backend).
- [ ] Multi-repo `/workspace` on EC2: `.repos.txt` registry + 10-min sync cron.
- [ ] `/api/forge/tick` endpoint: picks work, dispatches, scores.
- [ ] Render cron `*/20 * * * *` calls the endpoint.
- [ ] Forge ticks run for 24h with merge_rate ≥ 50% on at least one non-backend repo.
- [ ] Per-repo `atris/lessons.md` shows learnings appended automatically.

---

## User Impact

Every registered repo improves while you sleep, with PR audit trail and revert-safe gates. New repo onboarding = one line in `.repos.txt`. Cost per merged PR is bounded (concurrency cap + budget alarm). For Atris customers later: rent the loop as a service.

---

## Technical Notes

- Reuse existing CodeOps infra in `atrisos-backend/backend/services/error_service.py:1583` (`improve_pipeline`).
- Hardcoded `CODEOPS_REPO = "atrislabs/atrisos-backend"` at line 747 must become a parameter.
- `/workspace/atrisos-backend` paths in Opus prompts at lines 1036, 1269, 1696 must template the repo name.
- Env vars per repo via SSM: `/atris/envs/<repo>/*` → decrypted to `/workspace/<repo>/.env` on EC2 boot.
- Auth scope reminder: pushing `.github/workflows/*` requires PAT `workflow` scope (`gh auth refresh -s workflow`).
- Forgepilot tick discipline (plan-review + output-review via codex) is the per-tick spec — see `atrisos-backend/.claude/skills/forgepilot/SKILL.md`.
