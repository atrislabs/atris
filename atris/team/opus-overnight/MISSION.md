# Mission — opus-overnight

<!-- Human-authored purpose file. Keep this durable; runtime state belongs in .atris/state/*.jsonl and now.md. -->

## North Star

**AGI is the mission.** Concretely, the path is: the best model that works with Atris first (Atris-shaped, customer-trajectory-driven, vertically RL'd), then we swap the base for a better one when the loop justifies it. The loop, the data, and the published number are the moat — not the base model.

The motto: **every tick, name the 1%.** Each tick must answer "what's 1% better than last tick, and on what axis?" If a tick can't name its 1%, log it as a no-lift tick honestly and pick a different artifact.

## The Motto

**Every tick, name the 1%.** Each tick must answer: "what's 1% better than last tick, and on what axis?" If a tick can't name its 1%, log it as a no-lift tick honestly and pick a different artifact.

## Acceptance Per Tick

ALL of:
1. One concrete artifact landed in `rl-exp2/` (script, doc, eval, dataset, comparison) on a tick-prefixed commit.
2. **The tick summary names its 1% — what got better, by how much, vs what baseline.** Examples: "+1 training mode unlocked (DPO)", "−1 ambiguity in publishable-number rubric", "+5pp clarity on which base model swap is right", "no-lift tick: tried X, didn't move forward, here's what we learned."
3. `npm test` in atris-cli still green if any atris-cli code touched (usually none).
4. A mission-tick receipt recorded via `atris mission tick <id> --summary "Tick N: ... · 1%: <delta>"` so the operator sees the delta in `atris mission status` without reading my chat.
5. **Zero dollars spent during the tick** — no firectl create/fire/scale, no GPU rentals, no atrisos-backend master commits.

## Bounded Scope

- Code/docs in `rl-exp2/` — write freely.
- Reads from `atrisos-backend/backend/rl/` and `atris/features/rl-gym/` — write findings into `rl-exp2/notes/`, never modify the backend without explicit approval.
- Supabase reads via the existing trajectory_service shape — never insert/update.
- `firectl list / get / whoami / show` — read-only fine; `create / scale / delete` forbidden.

## Domains In Order

1. **Evaluator surface** — heuristic v1 shipped (commit `ae14e32`); LLM-judge v2 next.
2. **Corpus** — build_sft_corpus.py shipped (commit `bd171fb`); add eval-prompts companion + a dry-run sample dataset for review.
3. **Base-model swap analysis** — Kimi K2 vs Qwen3.5-30B vs GLM-4.5-Air vs GPT-OSS-20B on Fireworks: cost, throughput, RFT shape support.
4. **Strategy doc** — smallest publishable number that lets Atris claim "top RL co for vertical workspaces."
5. **rl-gym artifact survey** — 192 commits, 166 proof artifacts already in atrisos-backend. Map them so future ticks reuse instead of rebuild.

## Stop Condition

- Wallclock past 2026-05-14 09:00 → mark mission stopped, write final summary.
- Operator says "stop" → mark mission stopped, no further ticks.

## Hard Boundaries

- **Never** run `firectl deployment update` to scale anything.
- **Never** run `firectl create` for SFT/RFT jobs without explicit operator approval.
- **Never** push to `atrisos-backend` master.
- **Never** touch `atris2-fast-kimi-candidate-b300`.
- **Always** commit to `rl-exp2/` (local, no remote yet) so artifacts are durable but quarantined.

## Search Discipline (anti-laziness rule)

When the operator says "X exists in our code" or "we have X" and a grep returns 0 hits — **do NOT conclude X doesn't exist.** That conclusion is a recurring failure mode (see `atris/lessons.md` slug `narrow-grep-hides-matches`).

The required search ladder:
1. `grep -rn "<term>" <repo>/` — whole repo, no subdir gating
2. If still nothing, try variants: case-insensitive (`-i`), alternative spellings, related terms
3. Only after BOTH (1) and (2) miss, surface "I can't find it — point me at where" rather than declaring absence

Operator's trust is more reliable than my regex. Trust them, then go find it.
