# Split Unicode in newly discovered logs

Added six real follow scenarios for a log created after an empty opening snapshot. All six UTF-8 interior byte splits now run before startup, after startup, and in a newly discovered file: 18 scenarios, up from 12. Partial text stays hidden, completed text arrives intact once, the next result survives, and interrupt exits 0.

Plan: empty snapshot -> create partial log -> wait through polling -> exact completed event once -> next result -> clean interrupt.

Files edited: `test/member-board.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/builder/logs/2026-10-15.md`, this receipt. Artifact: `atris/receipts/member-board-new-file-unicode-proof.txt`.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit: 0. Exact output: 124 tests, 124 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.

Real surface command: `node bin/atris.js member board --json --follow`, invoked by the tests in temporary progress directories. The proof file includes the actual executable paths, output from each run, and exit 0. Example output excerpt:

```json
{"member":"navigator","mission":"m-unicode","kind":"step","text":"reading 界 notes"}
{"member":"navigator","mission":"m-unicode","kind":"finished","text":"ok","ok":true}
```

The excerpt omits event timestamps; the complete exact records are in the proof file. No product code or dependencies changed. Existing rendered task-view edits were left unstaged.

Other commands: `atris mission status mission-2026-10-14-continue-improving-atris-mem-52869ba8`, `atris mission goal --json` (no goal candidate), `atris`, `atris task list --status open`, task new/claim/note/ready, `git status --short`, `git diff --check`, and `git merge-base --is-ancestor origin/codex/builder-continue-improving-atris-member-boar-20261014-191103 HEAD` (exit 0). Brain activate and compile were plan-only, exit 2; no generated policy changes were applied.

next_push: Prove split multibyte text remains intact when a live progress log is replaced while the old character is incomplete.
layer: behaviors
