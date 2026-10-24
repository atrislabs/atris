# Linked XP repair independently confirmed

The existing repair preserves valid XP despite damaged linked files. The bare XP suite passed all 56 checks with exit 0, and four direct CLI invocations passed with exactly one warning each.

## Scope
Mission: mission-2026-10-23-last-fix-on-pr-1488-agentxp--18427efa. Task: VAS-11.
Target branch: codex/validator-agentxp-stopped-counting-atris-xp-lo-20261023-034242.
Pulled with `git pull --ff-only`: Already up to date.
Reviewed existing repair d53810ef4 without changing runtime or test source.
Plan: old code fails -> repaired suite passes -> all-folder warning check -> save proof and push; stop before merge.

Files changed this increment:
- `atris/receipts/agentxp-corrupt-linked-review-2026-10-23.cjs`: rerunnable real CLI audit using disposable repositories.
- This receipt.
- `atris/MAP.md`: add audit route.
- `atris/refs/MAP-NOTES.md`: correct locked collection reference from 1095 to 1101.
- `atris/team/validator/logs/2026-10-23.md`: local ignored member log.

## Failing first
Exported HEAD with git archive to a scratch directory, replacing only commands/xp.js with `git show 506d88438:commands/xp.js`.
Ran bare: `node --test --test-name-pattern='corrupt linked' test/xp-workspace-root.test.js`.
Actual Node exit: 1. Both cases failed, with the malformed JSON exception and 1 !== 0.
The wrapper checking for the expected failures exited 0.
Scratch path and full output remain in the temporary directory named by /tmp/agentxp-review-before-path.txt.

```text
scratch: /var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/agentxp-before-review-nfee8fhw
✖ corrupt linked receipts are skipped without losing valid XP (2567.158417ms)
✖ corrupt linked episodes are skipped without losing valid XP (2059.711542ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4733.062375

✖ failing tests:

test at test/xp-workspace-root.test.js:437:3
✖ corrupt linked receipts are skipped without losing valid XP (2567.158417ms)
  AssertionError [ERR_ASSERTION]: Failed to collect local XP: Expected property name or '}' in JSON at position 1 (line 1 column 2)


  1 !== 0

      at TestContext.<anonymous> (/private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/agentxp-before-review-nfee8fhw/test/xp-workspace-root.test.js:477:16)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1062:25)
      at Test.start (node:internal/test_runner/test:959:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:332:17) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 0,
    operator: 'strictEqual'
  }

test at test/xp-workspace-root.test.js:437:3
✖ corrupt linked episodes are skipped without losing valid XP (2059.711542ms)
  AssertionError [ERR_ASSERTION]: Failed to collect local XP: Expected property name or '}' in JSON at position 1 (line 1 column 2)


  1 !== 0

      at TestContext.<anonymous> (/private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/agentxp-before-review-nfee8fhw/test/xp-workspace-root.test.js:477:16)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1062:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:752:18)
      at Test.postRun (node:internal/test_runner/test:1191:19)
      at Test.run (node:internal/test_runner/test:1119:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:332:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 0,
    operator: 'strictEqual'
  }

expected failing-first exit: 1

```

## Bare suite
Command: `node --test test/xp*.test.js test/mission-xp.test.js`
Exit: 0. Exact output:
```text
✔ Mission XP task titles keep the parser prefix and a short objective clause (776.845041ms)
✔ mission --xp-task routes verified goal proof into AgentXP acceptance (4553.741333ms)
✔ mission attach-task creates a task spine for an existing active mission (4396.274625ms)
✔ mission attach-task assigns engine-owned missions to functional owners (917.370583ms)
✔ collects accepted proof, persists a chain, and does not award duplicates on replay (438.978709ms)
✔ filters ineligible episodes and resumes an incomplete final JSON line (663.778ms)
✔ returns an empty verified projection when no episode file exists (320.280958ms)
✔ rejects malformed complete episode JSON without writing a projection (106.974042ms)
✔ accrual: projection sums only accepted receipts with positive XP (149.015458ms)
✔ accrual: today_xp counts only receipts accepted on the local day (217.679125ms)
✔ level boundaries: 999 stays level 1, exactly 1000 crosses to level 2 (395.07925ms)
✔ tampered integrity zeroes the projection instead of trusting receipts (269.541208ms)
✔ xp --local --json projects seeded episodes and writes the ledger triplet (809.457416ms)
✔ rejected episodes land in the receipt chain but never in the totals (540.916917ms)
✔ xp --local from a subdir resolves up to the workspace root by default (378.494542ms)
✔ empty workspace renders a level-1 zero card without inventing proof (783.957708ms)
✔ flag wrappers: inline --workspace=path wins over the split form (991.0875ms)
✔ xp --help prints usage and exits clean (214.883375ms)
✔ single-workspace default resolves the workspace root, not raw cwd (2.690417ms)
✔ a spine root above a subdir pulls xp state up; a standalone .atris stays put (48.016417ms)
✔ a real second-actor accept updates the main ledger automatically and survives removal of its checkout (6012.042ms)
ℹ real xp --local before: AgentXP 0 | Today 0 | Career Level 1
ℹ real xp --local after automatic acceptance: AgentXP 1 | Today 1 | Career Level 1
✔ shared XP roots preserve nested workspaces and never write into separate git storage (236.772208ms)
✔ local XP recovers a real stranded accept once, with independent review and workspace boundaries (6408.6025ms)
ℹ real xp before recovery: AgentXP 0 | Today 0 | Career Level 1
ℹ real xp after recovery: AgentXP 1 | Today 1 | Career Level 1
✔ new main-ledger reviews require a second actor even after completion (2619.104458ms)
ℹ unverified completed reviews: AgentXP 0 | Today 0 | Career Level 1
ℹ independently verified accepted review: AgentXP 1 | Today 1 | Career Level 1
✔ group acceptance refreshes verified XP before any XP read and excludes unsampled rows (3750.72975ms)
ℹ group acceptance before: AgentXP 0 | Today 0 | Career Level 1
ℹ group acceptance after: AgentXP 1 | Today 1 | Career Level 1
✔ verified linked receipts survive missing episodes and deduplicate recovered episodes (3688.412416ms)
✔ corrupt linked receipts are skipped without losing valid XP (2905.196458ms)
ℹ real xp --local --json: exit 0; {"agent_xp":2,"integrity":"verified"}; warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-9a0DBI/bad/.atris/state/career_xp_receipts.jsonl
ℹ real xp --local --json: exit 0; {"agent_xp":2,"integrity":"verified"}; warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-9a0DBI/bad/.atris/state/career_xp_receipts.jsonl
✔ corrupt linked episodes are skipped without losing valid XP (3244.117292ms)
ℹ real xp --local --json: exit 0; {"agent_xp":2,"integrity":"verified"}; warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-BCpC6F/bad/.atris/state/task_episodes.jsonl
ℹ real xp --local --json: exit 0; {"agent_xp":2,"integrity":"verified"}; warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-BCpC6F/bad/.atris/state/task_episodes.jsonl
✔ overlapping real collectors cannot append against a stale receipt head (2429.162166ms)
ℹ real concurrent xp: {"agent_xp":2,"integrity":"verified"}
✔ shared XP lock retries live owners, recovers dead owners and releases on failure (109.70575ms)
✔ xp status --all aggregates verified local workspace ledgers (4709.377958ms)
✔ xp sync dry-run builds a path-private AgentXP packet (570.867958ms)
✔ xp sync dry-run keeps earned AgentXP uncapped while form stays capped (524.8545ms)
✔ xp sync dry-run carries local business binding for org attribution (720.519667ms)
✔ xp sync dry-run allows public AgentXP opt-in for a business workspace (493.670625ms)
✔ xp sync all avoids top-level org attribution across multiple businesses (1316.673959ms)
✔ xp sync infers player from accepted local proof before OS user (1081.618708ms)
✔ xp sync infers player from logged-in account profile when present (712.355708ms)
✔ xp local activity detects assistant surfaces without inflating receipt XP (1633.276917ms)
✔ xp sync posts the packet with the AgentXP sync token (280.347667ms)
✔ xp sync falls back to logged-in Atris auth when no sync token is set (429.439791ms)
✔ xp sync without login points public players to login-first sync (244.398417ms)
✔ xp sync dry-run render points players to login-first publish (5.905708ms)
✔ xp sync render shows server public identity mapping (1.021375ms)
✔ xp sync render says when XP was saved internally (0.688458ms)
✔ xp sync render says when XP was published publicly (1.279708ms)
✔ xp status --all excludes tampered local ledgers from totals (810.377875ms)
✔ xp status fails closed when receipt chain metadata is tampered (925.636708ms)
✔ xp session writes a local capsule for the current proof-backed work window (655.28675ms)
✔ xp session --no-write previews receipts without mutating the local ledger (646.407542ms)
✔ xp session skips a partial trailing task episode without advancing the cursor (692.443041ms)
✔ xp status cursor stays byte-aligned after newline-terminated JSONL append (1209.564708ms)
✔ xp status records rejected reviews without adding XP (452.584541ms)
✔ xp status replays accepted episodes when the receipt ledger is missing (893.989459ms)
✔ xp session reports an unreadable task projection without blocking verified XP (719.091208ms)
✔ xp sync uses ATRIS_TOKEN env var when no --token or sync-token env is set (444.221792ms)
ℹ tests 56
ℹ suites 0
ℹ pass 56
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31613.865084

```

## Real command audit
Rerun: `node atris/receipts/agentxp-corrupt-linked-review-2026-10-23.cjs`
Exit: 0. The script invokes the actual CLI against a valid main ledger, a valid linked ledger, and a damaged linked file, separately for receipts and episodes. It checks the all-folder command before local recovery, JSON output, exact balance 2, verified integrity, exactly one stderr warning, one aggregated workspace, and unchanged damaged source bytes.
The stdout excerpts below select fields from the actual parsed CLI output.

```text
command: node bin/atris.js xp status --all --root /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM/main --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM/good --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM/bad --json
exit: 0
stdout excerpt: {"agent_xp":2,"integrity":"verified","workspace_count":1}
stderr: warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM/bad/.atris/state/career_xp_receipts.jsonl
command: node bin/atris.js xp --local --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM/main --json
exit: 0
stdout excerpt: {"agent_xp":2,"integrity":"verified"}
stderr: warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-e3pllM/bad/.atris/state/career_xp_receipts.jsonl
passed: corrupt linked receipts; balance 2; one warning per command; source unchanged
command: node bin/atris.js xp status --all --root /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh/main --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh/good --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh/bad --json
exit: 0
stdout excerpt: {"agent_xp":2,"integrity":"verified","workspace_count":1}
stderr: warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh/bad/.atris/state/task_episodes.jsonl
command: node bin/atris.js xp --local --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh/main --json
exit: 0
stdout excerpt: {"agent_xp":2,"integrity":"verified"}
stderr: warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/atris-xp-corrupt-8GT2lh/bad/.atris/state/task_episodes.jsonl
passed: corrupt linked episodes; balance 2; one warning per command; source unchanged

```

## Conclusion and limits
The prep brief's repeated-warning suspicion did not reproduce: collectAllLocalXpProjection canonicalizes and deduplicates shared roots before collection. No warning deduplication patch is needed.
Main-ledger corruption remains strict; only linked file failures are skipped. No dependencies changed.
No missing implementation context remained after reading the helpers, root resolver, and aggregation loop. Some startup brain/wiki files referenced by the adapter are absent in this checkout; activation offered a plan only. No broad regeneration was applied.
Pre-existing TODO changes and the untracked master-sync receipt were preserved and excluded from staging.
Review task remains pending human approval; no acceptance or merge.
Progress: both pre-fix regressions reproduced, 56/56 current suite passes, 4/4 direct command cases pass.
next_push: review the saved evidence and decide whether to approve the existing repair for merge.
layer: capabilities
