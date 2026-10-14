# Missing folders stay visible during final cleanup checks

Member cleanup now explains folders disappearing at the final activity check and names retained locks with their ages. The existing missing-folder lookup supplies the explanation; files and branches stay intact, and no removal record is written.

Plan: final activity failure -> check folder presence -> locate retained locks from the main repository -> keep branch.

## Real proof

Command: `node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, exit 0. It invokes the actual `node bin/atris.js member tidy --dir <generated copies>` twice, forwarding Git calls to real Git and moving only generated folders during the final check.

Output excerpt:

```text
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-w7cqCn
kept  landed-copy  folder is missing
cli exit: 0
kept  landed-copy  folder is missing; git lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-w7cqCn/locked/repo/.git/worktrees/landed-copy/locked (7199s old)
cli exit: 0
both timing cases passed; moved files and branches retained; no removal recorded
```

The regression test runs this same real audit and removes only its generated temporary fixture. The first attempt required exactly 7200 seconds and failed because cleanup captures its clock before the forwarding command creates the lock. The assertion now allows the ten-second setup window while still requiring the exact path and a reported numeric age.

## Required verification

`node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`, exit 0.

```text
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7615.474292
```

`git diff --check`, exit 0, no output.

Files edited: `lib/member-tidy.js`, `test/member-tidy.test.js`, `atris/receipts/2026-10-14-tidy-vanishing-folder-check.js`, this receipt, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and `atris/team/architect/logs/2026-10-14.md`. Commands also inspected mission status, member identity, Git status and diff, and task state; created, claimed, and noted the bounded task. Existing entrypoint and rendered task-list edits remain outside the change.

Progress: one repaired explanation; two real timing cases; one new regression test; 21 required tests pass; no new dependencies or file names.

next_push: Extend the final-check disappearance regression to ordinary private and shared locks.

layer: behaviors
