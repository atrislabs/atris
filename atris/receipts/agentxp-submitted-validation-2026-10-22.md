# Submitted AgentXP validation

Changed: recorded fresh validation of the submitted changes, without changing runtime behavior. The bare targeted run exited 0 with 43 passing checks and zero failures.

## Scope and state

Mission: mission-2026-10-22-agentxp-stopped-counting-atr-cf5b299d. Task: VAS-8. The current head is 8aee5cd3. Review is already open at https://github.com/atrislabs/atris/pull/1488 and remains unmerged. Existing proof already covers failing-first reproduction against old runtime and the real operator card before and after. No new failing-first claim is made here.

The initial race investigation stopped at source inspection when the existing open review was found. The review boundary was honored by keeping this increment to validation and evidence. The preparation brief lacked current command results and review status; those were obtained directly.

## Runnable proof

```sh
node --test test/xp-workspace-root.test.js test/xp.test.js test/xp-command.test.js
```

Exit 0. Exact summary:

```text
tests 43
suites 0
pass 43
fail 0
cancelled 0
skipped 0
todo 0
```

Real CLI output emitted by the isolated regressions:

```text
real xp --local before: AgentXP 0 | Today 0 | Career Level 1
real xp --local after automatic acceptance: AgentXP 1 | Today 1 | Career Level 1
unverified completed reviews: AgentXP 0 | Today 0 | Career Level 1
independently verified accepted review: AgentXP 1 | Today 1 | Career Level 1
group acceptance before: AgentXP 0 | Today 0 | Career Level 1
group acceptance after: AgentXP 1 | Today 1 | Career Level 1
```

The automatic approval tests inspect the saved balance before invoking XP, so this is evidence of automatic refresh rather than a repair caused by reading the card. No live jobs were accepted and no points were awarded by this increment.

`gh pr checks` exited 0: decks, test, and all eight unit shards passed on the submitted runtime head. These results precede this documentation-only commit. `git diff --check` exited 0 with no output before writing this receipt and is rerun before commit.

## Residual risk and next step

`collectLocalXpProjectionState` reads the receipt head, builds hashes, appends receipts, and writes the cursor and balance without a shared transaction or lock. Source inspection suggests simultaneous collectors could observe the same head. No two-process reproduction was run, so corruption is a hypothesis, not an observed failure. The current tests do not establish concurrent-writer safety. Historical recovery from deleted folders also remains limited by missing evidence; merge-only closures remain excluded.

Plan for a separate follow-up: two real CLI processes collect independently reviewed fixture episodes into one isolated shared ledger, then a third read checks integrity and exact-once credit. Do not weaken the independent-review gate. Only add serialization after reproducing a failure.

```text
accepted, independent proof -> automatic shared balance -> local card
simultaneous collectors    -> not yet reproduced       -> no safety claim
```

Files edited: this receipt and atris/team/validator/logs/2026-10-22.md. The existing generated atris/TODO.md modification is excluded from staging. No dependencies, runtime source, navigation routes, or source line numbers changed.

next_push: Reproduce simultaneous accepted-work collection with two real CLI processes and require a verified receipt chain with exact-once credit.
layer: capabilities
