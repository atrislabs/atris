# Auto-Improver Start Here

First work block:

1. Read `atris/team/auto-improver/now.md` and the latest mission receipt.
2. Pick one bounded mission step from verifier evidence, activation gaps, or the previous tick handoff.
3. Create or claim one `atris task` for that step before editing.
4. Make the smallest code, test, doc, lesson, or member-playbook change that improves the next tick.
5. Verify with `npm test`.
6. Run `atris task ready <id> --proof "..."`, then run the mission tick with a final `layer: ...` line.

Proof target:

- One task pending human approval, not accepted.
- One live `atris/runs/...` mission receipt whose verifier passed.
- Exact files changed, verifier commands, and next first move named in the task thread or member log.

Stop:

- Do not accept tasks, merge, publish, weaken the verifier, or edit another member's identity files.
- If the same approach fails twice, pause with the blocker and a concrete human ask.
