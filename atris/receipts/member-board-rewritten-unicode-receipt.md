# Split Unicode across live log rewrites

Added six live same-file rewrite scenarios; the required command passed with exit 0: 126 tests, 126 pass, 0 fail.

The old log ends inside a character. After the opening snapshot, the test rewrites that same file with an incomplete new character, confirms unchanged file identity, waits through polling, completes the line, and requires the exact text once followed by the correct result and clean interrupt. Coverage grows from 24 to 30 real Unicode scenarios. No runtime or dependency changes.

Plan: old incomplete character -> snapshot -> same-file rewrite -> quiet polls -> completed text once -> following result -> interrupt.

Files edited: `test/member-board.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and the local ignored `atris/team/builder/logs/2026-10-15.md`. Artifact: `atris/receipts/member-board-rewritten-unicode-proof.txt`.

Verify: `node --test test/member-board.test.js test/member-result.test.js`
Exit: 0. Output: 126 tests, 126 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.

Real command: `node bin/atris.js member board --json --follow`, invoked by the tests against temporary progress logs. Exact command paths and output are saved in the proof artifact. Excerpt:

```text
ℹ character é, split after byte 1, mode rewrite:
{"kind":"snapshot","at":"2026-10-15T08:09:41.871Z","dir":"/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-board-U86cgs","members":[{"member":"navigator","state":"working","last_result":"","last_result_reason":"","last_result_ran":"","last_result_engine":"","last_result_ago":"","no_result":false,"pid":null,"engine":"","alive":null,"running_for":"","job":"check text","step":"","ago":"0s ago","at":1792051781777,"idle":false,"asleep":false}]}
{"member":"navigator","mission":"m-unicode","at":"2026-10-15T08:09:41.777Z","kind":"step","text":"reading é notes"}
{"member":"navigator","mission":"m-unicode","at":"2026-10-15T08:09:41.777Z","kind":"finished","text":"ok","ok":true}
exit: 0
```

The first run passed 125 checks but failed the map-link check after five added lines shifted existing references. Corrected those references, then reran the full required command successfully. The carried-forward source branch is an ancestor of this checkout. Commands also run: atris, git status/diff/check, member identity and notebook reads, mission status/goal/attach-task, task list/new/claim/note/ready, brain activate/compile, and git commit/push. Mission task attachment found a busy lock; this bounded task records the proof separately. Brain commands remained plan-only, exit 2, rather than regenerating unrelated policy. The pre-existing rendered task view remains unstaged. The first review request rejected a command named in prose because that process had not run it; the next request linked the completed direct receipt and was accepted into Review without another runtime rerun.

next_push: Check same-size in-place rewrites with an incomplete Unicode tail, so recovery must detect changed bytes without a shrink.
layer: behaviors
