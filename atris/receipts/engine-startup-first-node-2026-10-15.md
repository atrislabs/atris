# Landing repair with a failing Node executable

The repair hint uses the checkout command when the first executable Node cannot launch Atris, even when a later Node works.

Files: lib/engine-resource.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-15.md, this receipt.

Real surface: the regression launches landing status, copies its repair command into /bin/sh and /bin/zsh, and checks the temporary startup file. The short command exits 42; the printed command exits 0 and prints `changed ~/.zshrc line 1 to:`.

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js && node bin/atris.js slop --staged`

Setup: mission task attachment was unavailable because its lock was held by another process; no lock was removed. Brain activation and compile returned plan-only output.

Result: exit 0, `tests 168`, `pass 168`, `fail 0`; writing check: `clean, no slop tells in 6 files`. `git diff --check` exited 0 with no output.

Review: a separate agent reviewed the diff and found no material correctness issues.

Cost: checking a same-checkout short command now launches a read-only version probe, with a two-second timeout.

next_push: Prove the repair hint falls back when the first executable Node times out, without trying a later Node.

layer: behaviors
