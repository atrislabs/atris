# Current-folder command lookup

Startup repair hints now follow empty search-path entries in shell order, verified by 162 passing tests and zero slop findings.

Files: `lib/engine-resource.js`, `test/engine-resource.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, and this receipt, `atris/receipts/empty-path-startup-2026-10-15.md`.
Member memory: `atris/team/executor/logs/2026-10-15.md` (local, ignored by git).

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js && node bin/atris.js slop --staged`
Exit: 0.
Output excerpt:
```text
startup repair lookup searches the current folder for empty PATH entries in shell order
ℹ tests 162
ℹ pass 162
ℹ fail 0
  ✓ clean, no slop tells in 4 files
```

Real surface: `node bin/atris.js engine sweep`, exit 0.
Output excerpt:
```text
to make that change, run node ~/arena/empire/.agent-worktrees/atris-cli/executor-continue-machine-memory-load-and-ssh-20261015-054013/bin/atris.js engine sweep --fix-startup; it saves the old file beside it first
```
The sweep listed agents and stopped none. The added regression runs real sh and zsh processes with five search-path arrangements, verifying old local installs are detected and repair arguments reach the current script unchanged. The repair execution tests add Node to PATH after checking lookup independently.

Review: second model reported no findings.
Additional check: `git diff --check`, exit 0, no output.
Setup limitation: mission attachment was locked by its running parent; a separate claimed task records this increment. Brain activation and compilation offered a plan only, so no generated policy files were changed.

Learned: an empty PATH segment means the current working folder, including when the entire value is empty. Dropping that segment can hide an older installation and misstate whether its runs are recorded.
next_push: Make printed repair commands work when Node is absent from the command search path.
layer: behaviors
