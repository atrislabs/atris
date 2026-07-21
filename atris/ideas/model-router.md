# model router

Goal: the best model router there is, built quietly on our own data.
Wish #29 (2026-07-21). Slice 1 landed via PR 536: router brain v1.

## the one idea

Every atris dispatch already writes a receipt: which engine ran, what kind of work, whether the verifier passed, how long it took. Routers elsewhere guess quality from proxies. We measure it. The router that learns from verified outcomes on your own workload beats any router that guesses.

## what "best" means (build checklist)

1. Route on verified outcomes, not assumptions.
2. Per-request constraints: cost cap, deadline, quality floor, solved together.
3. Route per workflow step (retrieve / plan / edit / review / verify), not just per prompt.
4. Learn continuously: shadow-test new engines on real completed work before trusting them.
5. Session and cache consistency: keep a job pinned once a lane is warm.
6. Failover that also catches bad answers that exit 0 (needs capability 1).
7. Every pick explainable in one sentence, spend attributable per lane.

## current state

Slice 1 landed: `lib/router-brain.js` scores engines per task type from receipts (verified pass rate, median duration, 30-day-half-life recency) and reranks `resolveEngineForRole` in `lib/engine-registry.js`. Thin data (under 3 receipts per engine+task type) falls back to the legacy order, so behavior only changes once the data earns it. `ATRIS_ROUTER_EXPLAIN=1` prints why a pick won.

Routing surfaces still hardcoded (full audit in the 2026-07-21 recon): one-lap executor/validator pick, fleet restaffing ladder, mission auto-runner, backend tier/provider selection, the dormant cost map in the backend openrouter client.

## roadmap (one slice per flight)

1. router brain v1 - LANDED (PR 536)
2. restaffing ladder: fleet fallback ranked by task-type track record + model-family diversity, not install order
3. step-aware routing: mission/one-lap tag each step role; brain routes per step
4. budget-constrained picks: per-dispatch cost cap + deadline over receipt-measured latency
5. shadow onboarding: new engine runs N shadow flights on real completed tasks before entering the ladder
6. backend unification: same brain scores atris2 tier/provider picks; wire the dormant cost map
7. `atris route why` surface: decision observability as a product story

## known gaps

- Stateless fragments ("and the second one?") route to the cheapest lane; the right fix is session stickiness (checklist 5), not keywords. Found in the 7/21 overnight run.

- Wish intake splits semicolon wishes and drops clauses (logged on wish #29).
- One-lap sometimes dispatches an ask it should refuse: CLI-1170.
- `atris engine resolve` explanation surface: CLI-1171.
