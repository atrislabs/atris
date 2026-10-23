# AgentXP accepted-work collection

New accepted work now reaches the main checkout's ledger automatically. The failing linked-checkout regression passed after the fix; 124 related checks passed with exit 0.

## Cause and evidence

The main ledger was fully read, not stuck behind its cursor. Its episode file and cursor were both 5,637,397 bytes. The task database records positive reviewed events in five separate atris-cli checkout folders since October 15, rather than the main folder. Tasks deliberately keep their own checkout location so checks run against the correct code. The episode writer and post-accept XP refresh incorrectly used that temporary location too.

The regression fixture comes from reviewed event `01M5KC5M7JY5FAQGHJS2Y5FAQG`, accepted at `2026-10-23T03:16:45.938Z`, October 22 locally. It records reward 1, proof, two review actors, independent reviewer `autoland-verifier`, and machine verification. Names and proof paths are sanitized. The isolated runtime uses a real artifact test instead of the original diff-only check; current human acceptance refuses diff-only checks. The test uses the actual automatic acceptance command, a temporary database and home, and a real Git linked checkout.

## Plan and changed files

`accepted review -> shared episode file -> automatic shared XP refresh -> local display`

- `lib/career-xp-root.js`: find the main checkout while preserving nested workspace boundaries; fail back to the selected folder when Git cannot resolve a checkout.
- `lib/task-db.js`: append episodes to that shared root, retaining original job location inside each episode.
- `commands/task.js`: refresh the same root after acceptance.
- `commands/xp.js`: local reads and session writes resolve the shared root; account aggregation keeps historical separate ledgers.
- `test/xp-workspace-root.test.js`, `test/fixtures/xp/accepted-review.json`: real accepted-job regression, automatic refresh, deletion survival, repeated reads, explicit selection, legacy account totals, and non-earning cases.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: shared-ledger navigation.
- This receipt. Member learning is in the ignored local October 22 log.

## Red, then green

Before source edits: `node --test test/xp-workspace-root.test.js`, exit 1. Acceptance succeeded, but reading the main ledger immediately afterward failed with `0 !== 1`.

Runnable focused check:

```sh
node --test test/xp.test.js test/xp-workspace-root.test.js
```

Exit 0, 30 passed, 0 failed.

Related checks:

```sh
node --test test/xp.test.js test/xp-workspace-root.test.js test/xp-command.test.js test/task-worktree-state.test.js test/task-workspace-root.test.js test/task-sweep-auto-accept.test.js test/task-review-autoaccept.test.js test/review-integrity.test.js test/auto-accept-certified.test.js test/task-proof.test.js
```

Exit 0. Exact final totals: `tests 124`, `pass 124`, `fail 0`. `git diff --check` exited 0 with no output. No dependencies changed.

## Real CLI before and after

The regression invokes `node bin/atris.js xp --local` before and after automatic acceptance. Exact output excerpts, both exit 0:

```text
before: AgentXP 0 | Today 0 | Career Level 1
after:  AgentXP 1 | Today 1 | Career Level 1
```

The test first reads the shared projection file, before any XP command, proving acceptance itself updated it. Claims, open jobs, pending review, self-review, rejection, missing proof, unverified reviews, and merge-only closures earn no additional XP. Removing the linked checkout leaves its accepted XP intact. Old separate ledger XP remains in account totals without duplicating the new shared receipt.

The live main checkout was also measured with `node bin/atris.js xp --local --workspace /Users/keshavrao/arena/atris-cli`, before and after the code change, both exit 0:

```text
before: AgentXP 1,131 | Today 0 | Career Level 2
after:  AgentXP 1,131 | Today 0 | Career Level 2
```

This change fixes future accepted work. It does not replay old database events or backfill missing historical episodes. No live acceptance was fabricated to change that number. Existing eligibility and reward rules are unchanged. Full-suite testing was not run; the bounded related checks above were run bare.

The mission explicitly authorizes the validator to implement this repair. This is a proposed patch for another actor to review, with no self-acceptance or merge. Brain activation and compilation returned exit 2, plan only, requiring `--yes`; generated policy files were left out of this focused patch. The first mission attachment attempt reported a busy lock, so the work was recorded in a separately claimed task.

next_push: Recover historical verified accepts from the task database into the shared ledger with event-id deduplication and preserved acceptance dates.

layer: behaviors
