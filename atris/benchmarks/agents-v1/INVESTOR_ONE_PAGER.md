# Atris Agent Benchmark — Investor Brief

**July 2026 · agents-v1 · 25 tasks · 3 engines scored**

---

## The problem

Every company is buying coding agents. Almost nobody can answer the question that matters:

> *Does this agent do the work **and** leave your codebase intact?*

Vendor demos show cherry-picked wins. Internal evals are ad hoc. There is no standard yardstick for **knowledge work** — reading unfamiliar code, following constraints, building to spec, recovering from broken state, and knowing when to stop.

---

## What we built

**Atris Bench** — a repeatable exam any company can run on their agent.

```bash
atris bench run --pack agents-v1 --engine <theirs>
atris bench report --pack agents-v1
```

- **25 tasks** in isolated workspaces (not your repo)
- **5 categories**: navigate · edit · contract · build · recover
- **Objective scoring** — deterministic checks (files, git state, tests, hashes), not "the model said it worked"
- **Honesty rule** — every task must fail with a do-nothing engine and pass with its reference solution (enforced in CI)
- **Receipts** — every run appends a JSON record you can audit or share

This is a **proctor**, not a pitch deck. When an agent scores 19/25, you can read exactly which checks failed and why.

---

## First leaderboard (calibration run)

| | Claude | Cursor | Codex |
|---|:---:|:---:|:---:|
| **Score** | 25/25 | 24/25 | 25/25 |
| Navigate / Edit / Contract | 5 · 5 · 5 | 5 · 4 · 5 | 5 · 5 · 5 |
| Build / Recover | 5 · 5 | 5 · 5 | 5 · 5 |
| **Avg time per task** | 37s | 79s | 41s |

**The one failure that matters:** Cursor did not lose on reasoning. On one edit task it **deleted a file it was never asked to touch**. The other two engines passed the identical check through the identical harness.

That is the product insight: we measure **collateral damage**, not just "did the code compile."

---

## Why this is defensible

| Property | What it means |
|----------|---------------|
| Falsifiable | Null engine fails every task — the exam is not rigged to pass |
| Solvable | Reference solution passes every task — the exam is not impossible |
| Calibrated | Two independent Sonnet runs scored 10/10 on exemplars with matching failure maps |
| Auditable | Full run logs in `results.jsonl`; failed tasks show the exact assertion |
| CI-gated | Landed on master with test coverage; benchmark shipped in one weekend |

---

## What we are **not** claiming

- This is **v1 calibration**, not a final ranking of frontier models
- Two perfect scores mean the top end needs a harder tier next
- Tasks are bounded micro-scenarios, not whole-repo complexity
- One run per engine so far — variance bands come in v1.1

We are honest about limits because that is what makes the number investable.

---

## Why it matters for Atris

Atris is the operating system for AI work in a codebase — tasks, proof, missions, agents. The benchmark closes the loop:

```
hire an agent → run the exam → get a scorecard → decide with receipts
```

**Demo in one line:** *"Run your agent on our 25-task exam. We hand you a scorecard and the receipts."*

**Commercial angle:** Enterprises evaluating agent vendors need a neutral yardstick. Labs need regression signal when they ship a new model. Atris owns the harness, the pack, and the report — the same surface that already orchestrates agent work.

---

## What's next

- **v1.1 pack** — harder contract traps, partial credit, multi-step recovery
- **Third-party runs** — any company runs `atris bench run` on their agent, publishes scorecard
- **Continuous eval** — wire into release gates the way unit tests already gate merges

---

**Contact / demo:** `atris bench run --pack agents-v1 --engine claude`  
**Repo:** [github.com/atrislabs/atris](https://github.com/atrislabs/atris) · pack lives at `atris/benchmarks/agents-v1/`
