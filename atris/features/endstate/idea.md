# Project Endstate

> **Status:** v2 — harness verified 2026-04-08
> **Created:** 2026-04-07
> **Last Updated:** 2026-04-08

---

## Problem Statement

Recent autonomy benchmark narratives raised the bar for software agents, but public wins still blur model quality, harness quality, and hidden operator help. Atris has enough local primitives to challenge that story, but right now a public win is still a slogan instead of a falsifiable eval.

---

## Solution Design

Define one public benchmark that compares a pinned single-model baseline against a coordinated stack run on the same repo-improvement tasks, time budget, and review bar across `atris-cli` and `atrisos-backend`. Reuse Atris primitives instead of inventing a new framework: `autopilot` for execution, `experiments` for repeatable packs, `wiki`/`loop` for memory refresh, and the journal/TODO/MAP layer for artifacts and scoring. The feature wins when the system comparison is reproducible and the stack produces a clearly better reviewed outcome than the baseline.

---

## ASCII Visualization

```text
fixed task set
    |
    +--> baseline: 1 model + same repo snapshot
    |        |
    |        +--> edits + tests + review + artifacts
    |
    +--> stack run: coordinated models + same repo snapshot
             |
             +--> edits + tests + review + artifacts
                      |
                      v
               same scorecard
                      |
                      v
                 publish delta
```

---

## Success Criteria

- [x] the benchmark names exact repos, task set, time budget, and allowed operator input
- [x] the scorecard measures reviewed completion, test pass rate, memory sync, and intervention count
- [x] the single-model baseline protocol is pinned tightly enough to rerun
- [x] the stack protocol is pinned tightly enough to rerun
- [x] the public win condition is explicit: the stack must beat the baseline on total score without losing reviewed completion

---

## User Impact

This turns chest-beating into evidence. Instead of arguing about benchmark screenshots, Atris gets one reproducible challenge where the harness, memory, and coordination layer can prove they matter more than a naked model.

---

## Technical Notes

- Compare systems, not raw weights.
- Keep the repo snapshot, task brief, and time budget identical across runs.
- Preserve full artifacts: prompts, diffs, tests, review result, wiki state, and human interventions.
- Do not hide manual rescue work inside the "autonomous" run.
