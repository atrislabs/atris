# Split Unicode across log replacement

Added six real follow scenarios that atomically replace a log while its old tail ends inside a character. Every interior UTF-8 split of two-, three-, and four-byte characters is checked. The old fragment never emits, the replacement waits for its newline, its exact text arrives once, the next result survives, and interrupt exits 0. Live Unicode coverage grows from 18 to 24 scenarios.

Plan: old incomplete character -> opening snapshot -> replace with incomplete new character -> quiet polls -> complete event once -> following result -> clean interrupt.

Files edited: `test/member-board.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/builder/logs/2026-10-15.md`, and this receipt. Artifact: `atris/receipts/member-board-replaced-unicode-proof.txt`.

Verify command: `node --test test/member-board.test.js test/member-result.test.js`
Exit: 0. Exact output: 125 tests, 125 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.

Real surface command: `node bin/atris.js member board --json --follow`, run by the tests against temporary progress directories. The proof file records exact executable paths, complete stdout, and clean exit codes. One exact output excerpt:

```text
ℹ character 界, split after byte 2, mode replacement:
{"kind":"snapshot","at":"2026-10-15T08:01:52.288Z","dir":"/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-board-PdNmGQ","members":[{"member":"navigator","state":"working","last_result":"","last_result_reason":"","last_result_ran":"","last_result_engine":"","last_result_ago":"","no_result":false,"pid":null,"engine":"","alive":null,"running_for":"","job":"check text","step":"","ago":"0s ago","at":1792051312196,"idle":false,"asleep":false}]}
{"member":"navigator","mission":"m-unicode","at":"2026-10-15T08:01:52.196Z","kind":"step","text":"reading 界 notes"}
{"member":"navigator","mission":"m-unicode","at":"2026-10-15T08:01:52.196Z","kind":"finished","text":"ok","ok":true}
exit: 0
ℹ actual command: /opt/homebrew/Cellar/node/25.6.1/bin/node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/builder-continue-improving-atris-member-boar-20261015-003022/bin/atris.js member board --json --follow
```

Commands run: mission status and goal (no native goal candidate), task list/new/claim/note/ready, git status/diff/check, ancestry check (exit 0), brain activate and compile (plan-only, exit 2). Mission task attachment reported a busy lock, so a separate bounded task records this proof. No product code or dependencies changed. Existing rendered task-view edits remain unstaged.

## Review handoff caveat

The direct frozen command passed all 125 checks on Node 25.6.1, with full output saved above. Requesting review with an automatic rerun subsequently failed: 86 passed, 39 failed, exit 1. Its compact failure receipt is `atris/runs/2026-10-15-task-bci-25-2026-10-15T08-04-05-838Z.json`; the stored output omits individual failures. A login-shell probe resolves Node 20.18.0 rather than the direct shell's Node 25.6.1, a possible cause that has not been confirmed. No code changed between runs. The task is in Review using the direct proof, with the failed automatic run explicitly disclosed; acceptance remains pending. The builder log is locally ignored and was updated on disk.

next_push: Check split Unicode recovery after an in-place log rewrite while the old character is incomplete.
layer: behaviors
