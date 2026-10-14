Cleanup now names locks created after the last safety check when Git refuses removal, verified by the real cleanup command and 30 passing checks, exit 0.

Files edited: commands/land.js; test/worktree-removal-guard.test.js; atris/receipts/2026-10-14-land-vanishing-folder-check.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md.
Artifact: atris/receipts/2026-10-14-land-refused-locks.md.

Plan: passing activity check -> real Git refusal -> fresh lock inspection -> keep folder and branch.
Proof command: node atris/receipts/2026-10-14-land-vanishing-folder-check.js
Exit: 0.
Real CLI command inside the fixture: node bin/atris.js land --reap --force --no-remote
Output excerpt:
command: node bin/atris.js land --reap --force --no-remote
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-y5luuF/after/landed-copy (folder is missing)
  still flying (recent work, left alone): 0
cli exit: 0
command: node bin/atris.js land --reap --force --no-remote
landing cleanup done: 0 pieces cleared, 0 side copies removed
  ✋ kept, needs a human: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-y5luuF/refused/landed-copy (git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-y5luuF/refused/repo/.git/packed-refs.lock (14400s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-y5luuF/refused/repo/.git/worktrees/landed-copy/index.lock (10800s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-land-vanishing-y5luuF/refused/repo/.git/worktrees/landed-copy/locked (7200s old))
  still flying (recent work, left alone): 0
cli exit: 0
all seven timing cases passed; Git refusal after a passing check named three locks and distinct ages; files, locks, branches, and Git records retained; no removal recorded


Verify command: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0.
Output excerpt:
✔ tidy removes landed clean copies and leaves everything else to git and the rules (1145.115875ms)
✔ tidy names private and shared locks even when the work has not landed (1557.694542ms)
✔ tidy names private and shared locks when a landed copy is still running (1489.684667ms)
✔ tidy keeps old private and shared git locks and reports every path and age (729.993166ms)
✔ tidy keeps a copy git itself locked and reports the lock file and age (736.669416ms)
✔ tidy says a locked copy is missing and still names the lock file and age (699.924208ms)
✔ tidy asks origin for its current default branch instead of the stale local note (588.13725ms)
✔ tidy names locks and keeps every copy when the running-program scan fails (896.339375ms)
✔ tidy names locks and keeps every copy when origin lookup fails (1344.536834ms)
✔ tidy names locks when git cannot determine whether a copy landed (1483.230083ms)
✔ tidy names private and shared locks when a copy is detached (1427.99175ms)
✔ tidy names private and shared locks when a copy points outside the copies folder (1416.791416ms)
✔ tidy keeps late locks and keep markers whether the folder disappears or stays present, and folders moved after a passing check (7382.524708ms)
  kept /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-removal-guard-OWt0uD/repo/.regression-worktree-6e30f42a: git locks: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-removal-guard-OWt0uD/repo/.git/refs/heads/master.lock (7200s old), /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-removal-guard-OWt0uD/repo/.git/worktrees/-regression-worktree-6e30f42a/index.lock (7200s old)
✔ real cleanup names missing-folder ordinary locks without naming neighboring private locks (1131.478542ms)
✔ reap keeps late ordinary locks and keep markers in present and disappearing folders, and folders moved after a passing check (14539.743834ms)
✔ regression cleanup keeps folders that gain locks or disappear during or after its safety check (3770.128167ms)
✔ worktree cleanup keeps a copy moved after its final checks pass (1332.276375ms)
✔ land keeps a dirty copy moved while its backup is built and names the leftover lock (2082.818375ms)
✔ worktree cleanup names the leftover shared lock and its age for a moved copy (1212.465083ms)
✔ regression cleanup keeps old private and shared git locks created by the real check (423.351625ms)
✔ regression cleanup logs successful removal and leaves a pre-existing folder alone (426.093834ms)
✔ reap keeps a folder a run is working in, even with --force (126.408584ms)
✔ reap sees a real live process in the folder without being told (358.645792ms)
✔ reap keeps old private and shared git locks in preview and forced removal (248.426875ms)
✔ reap says a locked folder is missing and still names the lock file, even with --force (210.465083ms)
✔ reap names who removed a folder and why (179.512583ms)
✔ worktree cleanup keeps old private and shared git locks in preview and apply (129.637708ms)
✔ worktree cleanup names the lock file and age when git itself locked a folder (121.932833ms)
✔ worktree cleanup says a locked folder is missing and still names the lock file (134.82525ms)
✔ worktree cleanup names who removed a folder and why (138.764125ms)
ℹ tests 30
ℹ suites 0
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 26661.879708


Metric: seven real cleanup timing cases, up from six; the new case names three exact paths with ages of 7200, 10800, and 14400 seconds, keeps files, locks, branch, and Git record, and writes no removal event.
Slop: added JavaScript lines checked with atris slop detect /tmp/atris-late-lock-added.js, exit 0, no tells in 1 file. Whole-file scan found five pre-existing em dashes in unchanged comments.
Other checks: git diff --check, exit 0. Brain activation and compile were invoked in preview mode; compiled files are absent and broad generated policy changes were left outside this slice.
Existing edits in bin/atris.js, atris/TODO.md, and earlier member log entries were preserved.
next_push: Name late locks when Git refuses member-folder cleanup.

Proof follow-up: the proof-saving shell selected Node 20.18 and failed before the CLI could run; the direct frozen command passed under Node 25.6.1. Re-running proof capture with the supported runtime placed first in PATH; mission verification command unchanged.
Proof capture passed with Node 25.6.1 first in PATH: exit 0, 30 passed, 0 failed. Saved receipt: atris/runs/2026-10-14-task-acw-42-2026-10-14T21-47-36-846Z.json. Work is ready for review; automatic review cannot rerun the runtime-prefixed command. Code and proof committed and pushed.
layer: behaviors
