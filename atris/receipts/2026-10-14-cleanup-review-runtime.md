Cleanup review failures now have a reproduced cause: the proof shell selects unsupported Node 20, while direct cleanup and all 30 required checks pass on Node 25, exit 0.

Scope: evidence only. No cleanup code, mission settings, shell startup files, or review policy changed.
Plan: direct shell -> Node 25 -> cleanup runs; proof login shell -> Node 20 -> CLI stops before cleanup.

Cause: lib/task-proof.js:157 invokes bash with -lc. On this computer that login shell resolves node to /usr/local/bin/node, v20.18.0. The direct shell resolves /opt/homebrew/Cellar/node/25.6.1/bin/node, v25.6.1. bin/atris.js:12 requires Node 22.13 or newer, matching package.json. Test proof children use process.execPath, so starting the test with the old runtime also starts the CLI with it. The earlier failed receipt stores shortened output; this invocation exposes the missing cause.

Commands and actual output:
```text
node -p 'process.version + " " + process.execPath'
v25.6.1 /opt/homebrew/Cellar/node/25.6.1/bin/node
exit: 0
/bin/bash -lc 'node -p '\''process.version + " " + process.execPath'\'''
v20.18.0 /usr/local/bin/node
exit: 0
```

Failure reproduction:
```text
/bin/bash -lc 'node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js'
fixture: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-5ksUYa
command: node bin/atris.js member tidy --dir <generated copies>
atris needs Node 22.13 or newer. this is Node 20.18.0.
upgrade from https://nodejs.org, then run atris again.
cli exit: 1
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
1 !== 0
exit: 1
```

Supported real surface:
```text
node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js
cli exit: 0
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-kaDAoB/refused/repo/.git/worktrees/landed-copy/locked (7200s old)
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-kaDAoB/refused/repo/.git/worktrees/landed-copy/index.lock (10800s old)
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-kaDAoB/refused/repo/.git/packed-refs.lock (14400s old)
all seven timing cases passed; Git refusal after a passing check named three locks and distinct ages; files, locks, branches, and Git records retained; no removal recorded
exit: 0
```

Rerunnable frozen check, run bare on the supported direct runtime:
```text
node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
ℹ tests 30
ℹ suites 0
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 26376.706417
exit: 0
```

Files edited: atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md. Artifact produced: atris/receipts/2026-10-14-cleanup-review-runtime.md.
Other commands: mission status and goal lookup; task list/new/claim/note/ready; git status/diff/log/show/remote; targeted reads and searches; brain activate and compile (both exit 2, plan only, no writes); git diff --check; explicit staging, commit, push. Task proof uses the explicit supported executable to avoid login-shell lookup; the mission's frozen command is unchanged.
Task proof: the explicit Node 25 command also passed, exit 0, in atris/runs/2026-10-14-task-acw-45-2026-10-14T21-56-22-843Z.json. The first ready request rejected an incomplete benefit sentence after verification; resubmitting that saved receipt with a concrete benefit moved the work to review. The absolute command was not probed outside this checkout, so no portable automatic-landing claim is made.

Landing: evidence committed and pushed to the current remote branch; review is pending, with no acceptance or merge.
Metric: one runtime mismatch reproduced; seven real cleanup cases pass; three late lock paths and distinct ages retained; zero removals recorded; required checks 30 pass, zero fail.
Decision: proceed with the cleanup evidence. A separate scoped change should make proof runs use a supported runtime consistently. The full old-runtime suite was not rerun, so this receipt does not attribute every earlier failed assertion individually.
next_push: Prove fleet cleanup reports exact late lock paths and ages after a removal refusal.
layer: environment
