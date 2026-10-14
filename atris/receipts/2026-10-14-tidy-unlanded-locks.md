# Unlanded folder lock details

Cleanup now names private and shared lock files and their ages when work has not landed. The real cleanup preview and execution both kept the copy, and all 26 required tests passed, exit 0.

## Change

- `lib/member-tidy.js`: append the shared Git activity check to the existing unlanded-work explanation.
- `test/member-tidy.test.js`: one real-Git regression covers an unlanded commit, a private index lock, a private keep marker, and a shared branch lock. Both the library and actual CLI run in preview and execution modes.
- `atris/MAP.md` and `atris/refs/MAP-NOTES.md`: describe the reporting and move affected exact source pointers by one line.
- `atris/team/architect/logs/2026-10-14.md`: record work and learning.
- This receipt records runnable proof.

Existing edits to `bin/atris.js` and `atris/TODO.md` were left outside this commit.

## Proof

Rerun:

```sh
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
```

Actual final output, exit 0:

```text
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 23889.953958
```

The new regression invokes the actual CLI twice. The temporary root printed by this run was `/private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw`.

```sh
node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/.agent-worktrees/repo --dry-run
node /Users/keshavrao/arena/empire/.agent-worktrees/atris-cli/architect-continue-work-folder-protection-acro-20261014-172101/bin/atris.js member tidy --dir /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/.agent-worktrees/repo
```

Actual preview output excerpt, exit 0:

```text
kept  unlanded-locked  work not landed yet, 0m old; git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/repo/.git/refs/heads/master.lock (7320s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/repo/.git/worktrees/unlanded-locked/index.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/repo/.git/worktrees/unlanded-locked/locked (7260s old)
tidy: would remove 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/.agent-worktrees/repo
```

Actual execution output excerpt, exit 0:

```text
tidy: removed 0, kept 1, of 1 copy in /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-member-tidy-G02Xuw/arena/.agent-worktrees/repo
```

Execution named the same three full lock paths at 7321s, 7201s, and 7261s old. Assertions confirmed the file contents, branch and locks survived, and no removal log was created. The test removes only its generated fixture afterward; rerun the test command to recreate it.

`git diff --check` exited 0 with no output before verification. Initial inspection used `atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9`, `git status --short`, `atris`, `atris mission goal --json`, and `atris task list --status open`. Brain activation reported missing generated files in plan-only mode; no broad setup regeneration was applied.

Progress: one retained-folder reporting gap closed, one real-runtime regression added, 26/26 checks passing. No dependencies or new protected filenames.

next_push: Report exact lock files and ages when a landed member copy is kept because a program is running inside it.

layer: behaviors
