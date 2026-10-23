New AgentXP receipts now require independent review; a failing real-runtime regression reproduced seven unverified points, and 42 targeted checks passed after the fix.

## Bounded change

Plan: `real accepted job -> done-row self-review reproduction -> shared actor check -> real CLI proof -> review without merge`.

The normal collector trusted the upstream eligibility flag. The real task database permits positive reviews of completed jobs by their builder, so that flag did not establish independence. Receipt conversion now shares the independence predicate with linked-ledger recovery. A distinct accepting reviewer qualifies; a builder's acceptance needs certification and machine verification by the same distinct actor recorded as independent reviewer and among review actors. Existing legacy eligibility behavior and zero-point rejection receipts are preserved.

## Files

- `commands/xp.js`: share independent-review evidence across ordinary collection and recovery.
- `test/xp-workspace-root.test.js`: real task database writes based on this week's sanitized accepted job, then actual CLI reads in isolation.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: updated routes and line references.
- `atris/receipts/agentxp-independent-collection-2026-10-22.md`: this receipt.
- `atris/team/validator/logs/2026-10-22.md`: ignored local member log.

No dependencies changed. Generated task-view changes are excluded. Explicit mission authorization permits this implementation; another actor must review it, with no self-acceptance or merge.

## Failing first

`node --test test/xp-workspace-root.test.js` before source edits: exit 1, tests 6, pass 5, fail 1. Actual output was `AgentXP 7 | Today 7 | Career Level 1` where the test required zero. Each denied row was written through real `taskDb.reviewTask`, and its upstream eligibility flag was true.

The test uses `test/fixtures/xp/accepted-review.json`, real reviewed event `01M5KC5M7JY5FAQGHJS2Y5FAQG` from October 22 local time. Seven derivatives remove certification, machine proof, consistent verifier evidence, or independent reviewers, including a normalized builder alias. The unchanged real actor metadata qualifies and earns exactly one receipt after the denials, including repeated reads and the incremental cursor path.

## Rerunnable proof

```sh
node --test test/xp-workspace-root.test.js test/xp.test.js test/xp-command.test.js
```

Exit 0. Exact summary: `tests 42`, `pass 42`, `fail 0`. Actual child CLI output:

```text
unverified completed reviews: AgentXP 0 | Today 0 | Career Level 1
independently verified accepted review: AgentXP 1 | Today 1 | Career Level 1
```

The existing automatic-acceptance regression also passed, reading the balance file before any XP command to prove no manual collection is needed.

Live command:

```sh
node bin/atris.js xp --local --workspace /Users/keshavrao/arena/atris-cli
```

Exit 0, `AgentXP 1,145 | Today 3 | Career Level 2`, across 51 active days. Prior mission evidence remains `AgentXP 1,131 | Today 0` before the shared-ledger fix. This increment does not rewrite previously issued receipts or claw back old balances; it prevents new unsupported receipts. Local metadata remains the existing trust boundary, not cryptographic attestation. Full-suite testing was not run.

Frozen verifier: `git diff --check`, exit 0, no output.

The brief lacked the done-row review implementation and live current CLI output, both inspected directly. It also lacked current remote ancestry: the root-cause commits occur on the proposed branch, not origin/master. Brain activation and compilation each returned exit 2, plan only; no policy regeneration was included.

next_push: Audit historical accepted episodes in pruned job folders for a safe recoverable source, without granting credit to incomplete or builder-only work.

layer: behaviors
