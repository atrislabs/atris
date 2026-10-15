# Startup repair commands preserve checkout paths

Copied startup repair commands now keep shell punctuation literal. The required test and staged wording checks passed with exit 0.

Files edited: lib/engine-resource.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md. This receipt is also tracked. Member memory: atris/team/executor/logs/2026-10-15.md (local, ignored).

One bounded change: replace JSON string quoting with shell single quoting for paths containing punctuation, including embedded apostrophes. Simple paths retain the existing short form. The earlier requested remote branch is already an ancestor of this checkout (git merge-base --is-ancestor returned 0).

Rerun:
```sh
node --test test/engine-resource.test.js test/engine-dispatch.test.js && node bin/atris.js slop --staged
```
Actual exit: 0. Output excerpt:
```text
✔ copied startup repair commands preserve shell punctuation in checkout paths (765.187625ms)
ℹ tests 160
ℹ pass 160
ℹ fail 0
ℹ skipped 0
  ✓ clean, no slop tells in 4 files
```
Progress: seven path forms run through both /bin/sh and /bin/zsh, 14 successful invocations, preserving exactly ["engine","sweep","--fix-startup"]. One production line changed, no new dependencies. Independent read-only review approved and ran the two relevant tests with exit 0.

Real CLI command: node bin/atris.js autoland status. Exit: 0. Output excerpt:
```text
    to make that change, run node ~/arena/empire/.agent-worktrees/atris-cli/executor-continue-machine-memory-load-and-ssh-20261015-054013/bin/atris.js engine sweep --fix-startup; it saves the old file beside it first
```
No startup files were changed, and no live agents were stopped. git diff --check returned 0 with no output.

Task setup: mission attach-task could not acquire an existing lock; a separate bounded task was created and claimed for executor instead. Brain activation and compilation were plan-only, so no unrelated generated adapters were written. The task-rendered TODO was restored to its original contents to avoid an unrelated board diff.

next_push: Make PATH lookup skip non-executable atris entries so the repair hint follows the command the shell actually runs.

layer: behaviors
