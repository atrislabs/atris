# Current evidence before choosing work

Started November 8, 2026. Owner: builder. Executed by: Codex.

## Why this exists

The operator asked what work mattered most. The agent skipped Atris's current
task path, opened broad startup context, then dumped the entire task history.
The operator corrected the scope to the Atris CLI, the harness for multiple
agents, and set today's goal: choose useful next work, act autonomously, and
improve through better knowledge of what exists and what comes next.

The product principles are the four operating values in
`atris/atris.md`, section `operating rules`. A checked result counts;
existing work should make the next attempt faster; agents own missing pieces.

## Four questions

- Ambition: make current evidence part of the normal next-work and autonomous
  run paths, so correctness does not depend on an agent remembering a ritual.
- Agency: start from the failed request, real CLI behavior, database rows,
  stale projections, actual paths, and recorded outcomes rather than the
  compiled brain's generic next-move sentence.
- Acceleration: reuse `task next`, the shared boot reader, member prompts,
  the workspace goal, MAP, and existing task lessons and follow-ups. No new
  model call, dependency, scheduler, or learning store.
- Accuracy: reproduce the wrong routing and resurrection of a finished task;
  run the real CLI against contrasting isolated workspaces; independently
  review the diff; measure command duration and response size on real state.

Deeper task: give agents one bounded, sourced view of the current goal,
existing parts, alternative candidates, prior results and lessons before
choosing work. Missing or conflicting evidence must lead to discovery, and
the same view must reach autonomous runs. Prove the behavior against the
original request, stale and foreign state, ownership boundaries, missing
checks, large inputs, and the real CLI.

## Reused parts and missing responsibility

`commands/task.js` already selects a queue candidate and exposes its contract.
`lib/first-minute.js` reads local task state. `lib/member-task-pick.js` owns
the existing ownership and human-hold rules. `commands/mission.js` preloads
member context and already asks for `learned` and `next_push` receipts.
`commands/goal.js` owns `.atris/state/scoreboard.json`; MAP names reusable
parts; accepted and reviewed task metadata retains outcomes, lessons and
suggested follow-ups.

The missing responsibility is assembling these facts into a bounded decision
handoff. `lib/next-work-context.js` takes the workspace, current task rows,
selected candidate and owner. It returns current evidence, source paths,
explicit gaps and the next type of action. It does not rank business value,
claim work, change approval rules, execute checks, or award improvement.
Unavailable knowledge remains unknown. Long check commands are omitted,
never turned into executable ellipses. MAP paths must exist inside the
workspace; existence does not prove behavior.

## Current implementation

```text
current goal + task database + existing parts + prior outcomes
                             |
                    bounded evidence
                      /           \
               task next       autonomous prompt
                      \           /
                   inspect one relevant source
                             |
                   act -> check -> receipt
                             |
                 next result, lesson and follow-up
```

The fast reader preserves authoritative status for known task ids, including
older completions outside the boot list. Unknown offline tasks remain visible
as projection evidence, with an explicit authority gap. Known foreign ids
cannot enter through a damaged local projection. Recent outcomes are read
separately so a busy open queue does not hide all previous results.

Candidate keyword overlap is a discovery hint. The existing queue policy still
selects the candidate; these numbers do not measure customer or business value.
Reported results and recorded lessons are labeled separately from acceptance.
The active objective, fresh operator direction and frozen check retain authority.

## Verification and limits

The six initial regression cases failed on the original implementation and
passed after the change. Additional cases cover cross-workspace ids, older
completions, large sources, long commands, human acceptance, another owner,
untrusted snapshots, and candidate relevance.

```bash
node --test test/next-work-context.test.js test/task-next-truth.test.js test/first-minute--load-local-tasks.test.js test/guide.test.js test/mission-tick-prompt.test.js test/import-integrity.test.js test/repo-hygiene.test.js
```

The routine repository check is `npm run test:fast`. Local timing and packet
sizes are recorded in the main checkout's
`atris/runs/2026-11-08-next-work-context-benchmark.json`.

The independent review found and reproduced four misses before signoff:
bindings outside the shortlist could lose their owner, completed bindings
could look executable, assignments were not carried into the action hint,
and recency could be preempted by creation time or endgame tag priority.
Exact scoped lookups, terminal-state and assignment handling, and explicit
update-time ordering now cover those cases. The final focused run and the
independent repeat passed 47 checks with exit zero. The review receipt is
`atris/runs/2026-11-08-next-work-independent-review.json` in the main checkout.

Three fresh CLI processes over real local state produced a median lookup
time of 1.302 seconds and a 10,246-byte packet, including a 5,025-byte context.
The full task history in the same workspace was 863,483 bytes. These are local
command measurements, not total model-answer latency or a universal speedup.

In a separate generated workspace, the queue's newest item was toolbar polish
while the goal was reliable saved-note lookup. An independent consumer chose
the older lookup repair from the new evidence, inspected the existing reader,
and observed its failing check; the toolbar's check passed. A second actor
reran both checks and removed the temporary workspace. This is one synthetic
decision, not proof of general autonomous effectiveness. Its receipt is
`atris/runs/2026-11-08-next-work-decision-replay.json` in the main checkout.

This proves that the evidence reaches the next decision, and tests what the
packet says about the source. It does not prove better autonomous business
outcomes or improved model weights. Compare the next real recommendation and
completed run with the starting failure before claiming that improvement.

Rollback: revert the implementation commit. No data migration is involved.
Implementation is local until the independent review, checks and landing
receipt are recorded.
