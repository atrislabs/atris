# Moneyball AI Workforce

## Inbox

- A company has repeatable roles, like positions on a baseball team.
- The role is stable; the model running it is replaceable.
- A routine role should use the lowest-cost engine that reliably clears its proof threshold.
- Expensive models belong on high-judgment, high-novelty, high-taste, or high-cost-of-failure work.
- Every run leaves a receipt: task, outcome, model, cost, duration, and validation result.
- The workforce improves by learning role-by-role from those receipts.

## Central question

How should an AI workforce assign models to stable roles so it minimizes cost without sacrificing verified quality?

## Outline

- [ ] **The summer’s false choice:** token cost and sovereign AI dominate the conversation, while small teams are told they must either rent expensive frontier intelligence forever or build costly infrastructure themselves. Explain the confusion around model routers, compute, agents, and evaluation.
- [ ] **The Moneyball move:** Billy Beane did not seek a replacement star; he defined the production needed from each position. Translate that into AI: roles are stable contracts, while the model running it is replaceable.
- [ ] **Describe success before measuring it:** an evaluation is first a clear description of what good work looks like. The number is secondary. Use a strong model to help construct the evaluation when needed, but do not let abstract benchmark language hide the actual business outcome.
- [ ] **The first baseman:** routine, process-oriented work gets a narrow role, approved tools, a cheap reliable model, and a proof threshold. The goal is not the smartest model; it is the lowest-cost model that reliably gets on base.
- [ ] **The home-run hitter:** some roles require time to think, generalize, judge, and exercise taste. Spend more there. Frontier models are specialists, not the default staffing plan.
- [ ] **The operating loop beyond weights:** role instructions, tool limits, examples, retrieval, and role-specific evaluations shape an agent before any weight training. Receipts turn each run into evidence about cost, quality, failure, and escalation.
- [ ] **Improvement overnight:** use clean, validated receipts to update routing, prompts, tools, and evaluations. Failed work is diagnosis, not hidden noise. Human judgment remains the final gate for taste and high-impact decisions.
- [ ] **The sovereign path:** after enough clean role-specific trajectories exist, distill or fine-tune smaller open-weight specialists for the routine roles. Keep frontier models for training data, difficult escalation, and evolving taste, not as permanent mandatory infrastructure.
- [ ] **The experiment:** compare one-default-model staffing with role-aware routing on real work. Measure accepted outcomes, cost per accepted outcome, latency, escalation rate, and failure severity.

## Research brief for Fable

Develop a formal role-to-engine model with cost, probability of passing validation, uncertainty, and failure cost. Propose a routing algorithm that learns from receipts, a test for identifying high-judgment roles, and an experiment that compares this system against a single default model. Label hypotheses separately from empirical claims.

## Gate

- Human voice supplies the argument and examples.
- Research claims require sources or clear hypothesis labels.
- No draft is treated as finished until it passes the writing review.
