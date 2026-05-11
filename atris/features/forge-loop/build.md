# Forge Loop — build plan

> **Status:** in-progress (tick 1+2 done in this repo)

Ordered build steps. Each is one forgepilot tick: plan → codex review → build → measure → codex review → push.

---

## Tick 1 — Smoke scorecard ✅

**Repo:** atris-cli
**Files:** `scripts/smoke.sh`
**Verified:** PASS 14/14 on master; FAIL on 3 falsifiers.
**PR:** atrislabs/atris#3
**Status:** shipped (2026-04-15)

## Tick 2 — CI wiring 🟡 blocked

**Repo:** atris-cli
**Files:** `.github/workflows/smoke.yml` (written, uncommitted)
**Blocker:** PAT lacks `workflow` scope. Run `gh auth refresh -s workflow` then `git add .github && git commit && git push`.

## Tick 3 — Feature spec (this doc) ✅

**Repo:** atris-cli
**Files:** `atris/features/forge-loop/{idea,build}.md`
**Status:** shipped (2026-04-15)

## Tick 4 — Parameterize CODEOPS_REPO

**Repo:** atrisos-backend
**Files:** `backend/services/error_service.py`
**Diff:** `CODEOPS_REPO` constant → `repo` arg on `improve_pipeline` (default = `"atrislabs/atrisos-backend"`, backward-compat). Replace `/workspace/atrisos-backend` literals at lines 1036, 1269, 1696 with f-string from repo basename.
**Blocker:** atrisos-backend has uncommitted live agent activity (gtm/crm, security scans, prediction sims). Defer until clean tree or work on isolated branch with explicit user OK.

## Tick 5 — Multi-repo sync on EC2

**Files:** `atrisos-backend/scripts/codeops_sync_repos.sh` + `infra/codeops/.repos.txt`
**EC2 setup:** systemd timer `codeops-sync.timer` every 10 min runs script; clones missing, `git fetch && git pull --ff-only` each.
**Auth:** GitHub App installation token cached ~50 min from SSM `/atris/codeops/gh-app-pem`.

## Tick 6 — Work-pool reader

**Files:** `atrisos-backend/backend/services/forge_work_pool.py`
**Sources (weighted):** errors 100, failing CI 80, TODO.md backlog 50, inbox I# items 40, lessons.md "next: X" 30, open GH issues 25, stale env 20, MAP drift 15, test gaps 10. Decay weight by attempts to avoid beating dead horses.

## Tick 7 — Forge tick endpoint

**Files:** `atrisos-backend/backend/routers/forge.py`
**Endpoint:** `POST /api/forge/tick` → calls `forge_work_pool.pick()` → calls `improve_pipeline(idea, repo)`.
**Safety:** Dispatch lock per-repo (15-min TTL). Global concurrency cap = 3. Budget alarm via SES if daily token spend > $X.

## Tick 8 — Render cron

**Files:** `atrisos-backend/render.yaml`
**Schedule:** `*/20 * * * *`
**Cmd:** `curl -X POST $BACKEND/api/forge/tick -H "X-Forge-Token: $FORGE_TOKEN"`

## Tick 9 — Scorecard table + lessons writeback

**Files:** `atrisos-backend/backend/services/forge_scorecard.py`
**DynamoDB table:** `atris_ticks` — tick_id, repo, source, pr, ci_passed, merged, reverted_24h, tokens_cost_usd.
**Writeback:** Append outcome line to `<repo>/atris/lessons.md` automatically.

## Tick 10 — Honest-idle guardrail

**Files:** `atrisos-backend/backend/services/forge_work_pool.py` (extend)
**Rule:** If top-of-queue weight < 10 AND last 3 ticks merge_rate < 30%, sleep loop 1h, email digest "considered but skipped: …".
