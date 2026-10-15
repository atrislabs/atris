# Assigned jobs reach their named member

Assigned jobs now wait for the named member and take precedence over general work. Verified with `node --test test/task-owner-pick.test.js`, exit 0, three passing tests and no skips.

## Scope and plan

Proceed: use the saved assignment in the existing picker, preserve all safety holds, and retain job matching for unassigned work. The failure to avoid is allowing explicit assignment to bypass a human or protected-lane hold. The regression checks those holds against the real SQLite store.

`delegate -> saved assignee -> intended member preview -> atomic claim -> claim confirmation`

Files edited:
- `lib/member-task-pick.js`: skip assignments to other members, prioritize own assignments, and use inferred job types only for unassigned work.
- `test/task-owner-pick.test.js`: real delegation, idle preview, actual claim, priority and safety holds.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: navigation.
- `atris/receipts/task-owner-pick-2026-10-14.md`: this receipt.
- `atris/team/architect/logs/2026-10-14.md`: local member learning, ignored by Git.

## Proof

Before the repair, `node --test test/task-owner-pick.test.js` exited 1, with all three tests failing. A validator preview selected the job assigned to executor, reproducing the bug through the real command.

After the repair, the same bare command exited 0:

```text
✔ a delegated job waits for its named member, who previews and really claims it
task delegate exit 0: assigned to executor
validator preview: {"ok":true,"action":"member_go","mode":"idle","member":"validator","reason":"no task with a check"}
executor preview exit 0: Review the clock change
member go actual: Review the clock change, claimed by executor, stopped after confirmation (SIGTERM)
✔ assigned work comes first, in age order, then unassigned matching jobs
✔ assignment preserves human, protected lane, check, and claim holds
tests 3; pass 3; fail 0; skipped 0
```

The real CLI calls inside the first check were:

```sh
node bin/atris.js task delegate "Review the clock change" --to executor --tag review --verify "node --test test/clock.test.js" --json
node bin/atris.js member go validator --needs-check --dry-run --json
node bin/atris.js member go executor --needs-check --dry-run --json
node bin/atris.js member go executor --needs-check --json
```

These ran in an isolated temporary project with a real SQLite database. Delegation and the intended preview exited 0; the other member stayed idle. The final command was deliberately stopped with SIGTERM after real claim confirmation, before a paid engine could start. This proves dispatch and ownership, not completion of the delegated work.

Related check: `node --test test/member-task-pick.test.js test/task-reopen.test.js`, exit 0, 23 passing tests, no failures or skips.

State inspection: `atris mission status mission-2026-10-14-a-job-can-be-given-to-a-spec-c02900ff`; `git status --short`; `atris task list --status open`; `atris mission goal --json`. Mission task attachment was refused because the live parent holds the mission lock. The preloaded task was absent in this checkout's task store, so a dedicated local task was created and claimed before editing. The parent harness owns mission completion; the frozen check and lane were not changed.

Startup brain activation returned a plan requiring an explicit write option; the generated files were absent. No policy files were rewritten.

Metric: assigned-job regressions moved from 0/3 passing to 3/3 passing, including actual CLI claim confirmation. Existing picker and recovery checks remained 23/23 passing.

Stop: one bounded repair is proven. No human decision is required for this change.

next_push: Show a plain waiting reason when a named member cannot take an assigned job because it needs a runnable check.

layer: behaviors
