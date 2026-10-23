Historical accepted work now reaches the main XP card automatically; real CLI output and 41 targeted checks verified recovery without duplicate credit.

## One bounded increment

Plan: `registered job ledgers -> accepted proof + independent actor -> event-id deduplication -> main card`.

The prior increment already routed new accepted episodes to the main checkout. This increment recovers existing stranded episodes from Git's registered linked checkouts, at exactly the selected nested workspace offset. It appends receipts to the main receipt chain without rewriting source episodes. Existing receipt IDs prevent credit twice, preserving acceptance timestamps and job paths. Account aggregation resolves each shared workspace once, avoiding the same receipt appearing in both main and linked totals. Incomplete trailing JSON is deferred until the writer finishes.

## Exact files edited

- `commands/xp.js`: recover linked episodes during normal local collection; canonicalize account workspace roots.
- `lib/career-xp-root.js`: enumerate same-repository linked workspace paths, including a nested workspace absent from main.
- `test/xp-workspace-root.test.js`: failing real-job fixture recovery test; align the prior automatic-acceptance test with recovered historical totals.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: recovery and aggregation routes.
- `atris/receipts/agentxp-linked-recovery-2026-10-22.md`: this receipt.
- `atris/team/validator/logs/2026-10-22.md`: local ignored learning log.

Task state is recorded through the CLI, not hand-edited markdown. Its generated TODO changes are excluded from this patch.

## Test first and runtime proof

Before source edits, `node --test test/xp-workspace-root.test.js` exited 1: 3 passed, 2 failed. The new stranded-accept case expected `AgentXP 1 | Today 1` but actually displayed `AgentXP 0 | Today 0`. The earlier test, updated to expect recovery, also failed because the old main total was 1 instead of 3.

The fixture is the same real accepted reviewed event from this week, `01M5KC5M7JY5FAQGHJS2Y5FAQG`, already sanitized in `test/fixtures/xp/accepted-review.json`. Its acceptance actor equals its recorded builder. It qualifies because its recorded machine verifier is a distinct actor, listed among reviewers and matching the independent reviewer. The isolated test uses today's timestamp so its Today assertion remains valid on later runs, and asserts that timestamp survives recovery unchanged.

After the fix, commands were run bare:

```sh
node --test test/xp-workspace-root.test.js
```

Exit 0. Exact totals: `tests 5`, `pass 5`, `fail 0`. Real CLI diagnostics:

```text
real xp before recovery: AgentXP 0 | Today 0 | Career Level 1
real xp after recovery: AgentXP 1 | Today 1 | Career Level 1
```

```sh
node --test test/xp.test.js test/xp-command.test.js
```

Exit 0. Exact totals: `tests 36`, `pass 36`, `fail 0`.

Live command, run before source edits, then twice afterward:

```sh
node bin/atris.js xp --local --workspace /Users/keshavrao/arena/atris-cli
```

All exit 0. Exact output excerpts:

```text
before: AgentXP 1,131 | Today 0 | Career Level 2
after:  AgentXP 1,145 | Today 3 | Career Level 2
repeat: AgentXP 1,145 | Today 3 | Career Level 2
```

Fourteen episodes from seven linked ledgers earned 14 XP. Three original acceptance timestamps fall on October 22 Pacific, two around 04:14 local and the fixture around 20:16 local. The prep brief predicted Today 1; the actual timestamps prove Today 3. No acceptance was fabricated and no manual collect was run. Active days rose from 48 to 51.

Frozen check: `git diff --check`, exit 0, no output.

## Independence rule and limits

Recovery requires done status, explicit career eligibility, nonempty proof, positive reward, and an identifiable builder. A distinct accepting reviewer qualifies. If the accept actor is the builder, recovery requires machine verification and certification, with the same distinct verifier recorded as the independent reviewer and among the review actors. Missing identity, builder-only review, mismatched verifier, unverified machine checks, claims, attempts, open/review jobs, missing proof, and nonpositive rewards cannot earn recovered XP. Tests cover these denials and preserve separate nested workspace attribution and removal survival.

This bounded increment does not recover folders already removed and pruned from Git's registry, or receipt-only history with no surviving episodes. It does not harden the existing main-ledger eligibility gate for newly appended done-row self-reviews. That pre-existing bypass remains a concrete follow-up. Local metadata remains the existing local trust boundary, not cryptographic reviewer attestation. Full-suite testing was not run.

The prep brief lacked current command evidence, the latest commit and review-request status, and accurate local dates of recovered episodes. Those were inspected directly. Brain activation and compilation each returned exit 2, plan only; policy regeneration was excluded. Mission task attachment reported its existing busy lock, so this increment has its own claimed task. The validator is implementing under explicit mission authorization, with final review left to another actor.

next_push: Reject newly appended builder-only done-row reviews at the main XP collection gate, with a real-runtime failing test.

layer: behaviors
