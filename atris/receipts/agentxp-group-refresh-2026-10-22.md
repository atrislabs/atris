Grouped approvals now refresh earned points automatically; the real CLI regression failed first, then the bare targeted run passed all 43 checks.

## Scope and plan

`real accepted fixture -> group approval -> saved main balance -> XP card`

Files changed: `commands/task.js`, `test/xp-workspace-root.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and this receipt. Member log appended at `atris/team/validator/logs/2026-10-22.md` (ignored local state).

The prep brief lacked an executed grouped-approval reproduction. The new test uses the existing sanitized real accepted job from this week in `test/fixtures/xp/accepted-review.json`, preserving its builder, second actor, certification and proof. Two review jobs live in an actual linked Git checkout with an isolated task database and home. One is explicitly verified and the other accepted by sampling. No operator jobs are accepted in this test.

## Failing first

Before changing runtime code:

```sh
node --test --test-name-pattern='group acceptance refreshes' test/xp-workspace-root.test.js
```

Exit 1. Exact relevant output:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
0 !== 1
actual: 0
expected: 1
```

Both jobs had been accepted successfully. The failure read the saved main balance before any XP read could repair it. This isolates the automatic-refresh defect.

## Fix and proof

The group path now passes its review result to the existing refresh helper, as individual accept paths already do. The receipt collector's independent-review predicate and per-row eligibility remain unchanged. Only the explicitly verified job earns credit; accepting the other by sampling creates no earned receipt.

Run bare:

```sh
node --test test/xp-workspace-root.test.js test/xp.test.js test/xp-command.test.js
```

Exit 0. Exact summary: `tests 43`, `pass 43`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`.

The test invokes the real `task accept-group` CLI, inspects the saved balance before any XP command, and then invokes the real XP CLI from both main and linked folders. Exact diagnostics:

```text
group acceptance before: AgentXP 0 | Today 0 | Career Level 1
group acceptance after: AgentXP 1 | Today 1 | Career Level 1
```

The main episode ledger contains two episodes, one eligible; the receipt ledger contains exactly one receipt. The existing regressions also reject claims, attempts, unfinished work and unsupported self-review.

Actual operator card, run using the proposed source rather than the installed command:

```sh
node bin/atris.js xp --local --workspace /Users/keshavrao/arena/atris-cli
```

Exit 0:

```text
AgentXP 1,146 | Today 4 | Career Level 2
Last 365 days: 1,146 AgentXP across 51 active days
```

No manual collect step or operator acceptance was run. The live card is unchanged from the previous increment. The original mission before/after remains in the existing open draft pull request.

## Boundaries

No dependencies changed. Generated TODO changes are excluded. The patch remains for a non-validator actor to review; no self-acceptance or merge. Rollback: revert this increment's commit. Removed folders and silent Git lookup fallback remain separate unresolved recovery limits.

Brain activation and compilation each exited 2 in plan-only mode and listed generated adapters they would write. Missing optional brain/wiki files were not invented. No generated policy adapters were changed for this bounded fix.

Frozen check: `git diff --check`, exit 0, no output.

next_push: Reproduce Git root lookup failure with a real linked checkout, then preserve verified repository identity without weakening independent review.

layer: capabilities
