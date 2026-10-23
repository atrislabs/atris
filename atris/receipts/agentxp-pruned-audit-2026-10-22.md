Removed-folder audit found eleven accepted-event candidates missing shared receipts; the read-only audit exited 0 and all 42 targeted checks passed.

## Scope and result

This increment audits evidence only. No collection behavior changed, no XP was awarded by the audit, and no new failing-first claim is made. Earlier increments contain the failing-first implementation tests. Plan: `accepted events -> registered folders -> surviving episodes -> receipt IDs -> recovery boundary`.

`agentxp-pruned-audit-2026-10-22.cjs` opens the operator's task database with SQLite `readOnly: true`, reads Git registration and existing receipt files, and prints candidates. Its adjacent JSON file preserves the actual output. Run from this checkout:

```sh
node atris/receipts/agentxp-pruned-audit-2026-10-22.cjs
```

Exit 0. Output fields: `eligible_linked_cli_events: 26`, `eligible_this_week: 4`, `unregistered_candidates: 11`, `missing_main_receipts: 11`. All eleven folders and episode files are absent. All eleven current rows contain evidence satisfying the existing actor predicate, but current metadata is mutable and is not an acceptance-time snapshot. Four accepts date to May 20; seven date to October 14 or 15. This week's four eligible CLI accepts still have registered folders. The count is accepted review events, not merged changes or attempts.

One candidate retains a commit hint; ten do not. No candidate has a metadata key naming a repository, root, or workspace. The familiar folder prefix is a search filter, not evidence authorizing assignment to this repository. Current done status and an old positive event alone must not replace acceptance-time proof and reviewer identity. The audit does not reconstruct episodes from these mutable rows or alter the ledger. The next implementation needs a durable repository-to-workspace mapping and acceptance-time evidence before it can safely recover these candidates.

## Runtime proof

```sh
node --test test/xp-workspace-root.test.js test/xp.test.js test/xp-command.test.js
```

Exit 0, exact summary: `tests 42`, `pass 42`, `fail 0`. Real child CLI diagnostics remain:

```text
real xp --local before: AgentXP 0 | Today 0 | Career Level 1
real xp --local after automatic acceptance: AgentXP 1 | Today 1 | Career Level 1
unverified completed reviews: AgentXP 0 | Today 0 | Career Level 1
independently verified accepted review: AgentXP 1 | Today 1 | Career Level 1
```

The automatic-accept regression reads the projection before invoking XP. This is the proof of collection without a manual step. The live main checkout does not yet contain this proposed fix, so its card read alone cannot prove automatic acceptance refresh.

```sh
node bin/atris.js xp --local --workspace /Users/keshavrao/arena/atris-cli
```

Exit 0 at both the start and end: `AgentXP 1,146 | Today 4 | Career Level 2`, 51 active days. The latest proof is “Measure the full suite after the one-lap split,” accepted at `2026-10-23T04:14:41.080Z`. Local status also exited 0 with `agent_xp: 1146`, `today_agent_xp: 4`, `integrity_status: verified`, `collected_receipts: 0`. No manual collect command ran. Earlier mission baseline remains `AgentXP 1,131 | Today 0`; the intervening `1,145 | Today 3` is in prior receipts.

## Files and handoff

Changed: this receipt, adjacent audit script and JSON snapshot, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`; appended the ignored member log at `atris/team/validator/logs/2026-10-22.md`. Generated `atris/TODO.md` is excluded from staging. Rollback: revert this documentation and audit commit. No dependencies or runtime source changed. Existing pull request stays open, with no merge or self-acceptance.

The brief lacked current database evidence and repository attribution for removed folders. The real read-only audit supplied the first and established the remaining uncertainty. Mission attachment failed because its lock was held by another process; no lock was removed or mission changed. Brain activation and compilation returned exit 2, plan only, so no generated policy files were included.

Frozen verifier: `git diff --check`, exit 0, no output.

next_push: Preserve verified repository and workspace identity while a job folder still exists, then test acceptance after its removal without weakening independent review.

layer: capabilities
