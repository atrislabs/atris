# Corrupt linked files no longer hide valid XP

Linked receipt and episode files now fail independently. Both new runtime regressions failed before the fix and passed afterward; the bare XP suite passed all 56 checks, exit 0.

## Scope and plan

Task: VAS-11. Owner: validator. Requested branch: codex/validator-agentxp-stopped-counting-atris-xp-lo-20261023-034242.

corrupt linked file -> skip whole file and warn on stderr -> keep main and other linked balances

Files edited: `commands/xp.js`, `test/xp-workspace-root.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/validator/logs/2026-10-23.md`, and this receipt. The member log is ignored by repository policy and remains local; the other five files are committed.

Added `readLinkedXpFile` only to linked recovery reads. It catches a file read or JSON parse failure, emits one lowercase warning naming the file to stderr, and returns no rows from that file. Linked episode recovery gets the same protection because it has the same failure. The main receipt ledger remains strict. The collection lock and verified-chain filter remain in place. No dependencies changed.

The test creates a real repository with two registered linked checkouts, a valid main ledger, one valid linked receipt, and one linked file with valid rows surrounding a malformed middle line. It checks main and linked invocations, an exact balance of two, verified integrity, parseable JSON stdout, one warning, and unchanged corrupt source bytes. It covers receipts and episodes separately.

## Failing first

Command: `node --test --test-name-pattern='corrupt linked' test/xp-workspace-root.test.js`

Exit 1 before the runtime edit. Exact output excerpts:

```text
✖ corrupt linked receipts are skipped without losing valid XP
✖ corrupt linked episodes are skipped without losing valid XP
AssertionError [ERR_ASSERTION]: Failed to collect local XP: Expected property name or '}' in JSON at position 1 (line 1 column 2)
1 !== 0
ℹ tests 2
ℹ pass 0
ℹ fail 2
```

## Review state and delivery

Committed runtime repair: `d53810ef4`, pushed to the requested branch. No merge performed. Task VAS-11 is ready for human review, version 4; no acceptance requested or performed.

The task board required its own fresh verification. Its wildcard command was rejected by the empty-directory falsification check, so the same full suite was supplied with all five filenames explicitly. That full command passed, exit 0, creating local artifact `atris/runs/2026-10-23-task-vas-11-2026-10-23T15-55-14-807Z.json`; the attempt then rejected the landing sentence for lacking an explicit benefit. After correcting that sentence, the task board reran the two corruption regressions with `node --test --test-name-pattern='corrupt linked' test/xp-workspace-root.test.js`, exit 0, and recorded ready-for-approval state with local artifact `atris/runs/2026-10-23-task-vas-11-2026-10-23T15-55-44-095Z.json`.

## Passing verification

Command: `node --test test/xp-workspace-root.test.js`

Exit 0. Output excerpt:

```text
✔ corrupt linked receipts are skipped without losing valid XP
✔ corrupt linked episodes are skipped without losing valid XP
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

Rerunnable bare verification: `node --test test/xp*.test.js test/mission-xp.test.js`

Exit 0. Exact summary:

```text
ℹ tests 56
ℹ suites 0
ℹ pass 56
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Real CLI command, run directly on this computer after creating an owned temporary repository with the same corrupt-receipt scenario:

```sh
node bin/atris.js xp --local --workspace /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/agentxp-corrupt-proof-nksuk5/main --json
```

Exit 0. Exact stderr:

```text
warning: skipped unreadable linked xp file at /private/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/agentxp-corrupt-proof-nksuk5/bad/.atris/state/career_xp_receipts.jsonl
```

Exact stdout excerpt: `"agent_xp":2,"total_agent_xp":2,"today_agent_xp":2`. Integrity excerpt: `"integrity_status":"verified"`. The automated tests independently parse the entire JSON stdout and assert the warning is on stderr.

`git diff --check -- commands/xp.js test/xp-workspace-root.test.js atris/MAP.md atris/refs/MAP-NOTES.md`: exit 0, no output.

`git pull --ff-only`: exit 0, `Already up to date.` The target checkout was already on the requested branch. Its pre-existing TODO changes and untracked master-sync receipt were preserved and excluded from this commit. `atris brain activate --root . --verify` and `atris brain compile --root .` both exited 2 with a plan-only message, without writing generated policy files. Several compiled-brain context files are absent on this branch.

The preparation brief lacked the actual clean/dirty state and the episode failure proof. Inspection found two unrelated documentation changes, and failing-first coverage confirmed the episode reader has the same defect. No additional source exploration was required.

Mission attachment was attempted from the launching checkout but declined because its mission lock is held by the active runner. No mission verifier, lane, or other mission was changed. The scoped task is recorded separately and moved to review, without acceptance or XP award.

Progress: two reproduced failures repaired; all 56 requested XP and mission XP checks pass; real CLI returns two verified XP with one warning. Full repository suite not run. Skipped files contribute nothing until repaired, and existing main-ledger failures remain strict. Stop before merging, as requested.

next_push: independently review the corrupt-file recovery diff before approving a merge.
layer: capabilities
