# Grouped folder scan repair

The cleanup scan now detects all four review folders. The real source probe and all 26 required checks passed, exit 0.

Plan: Git worktree removal -> classify function as handling work folders -> scan companion recursive deletes.

Changed files: `test/worktree-removal-guard.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/architect/logs/2026-10-14.md`.

The scanner previously recognized functions that add or list worktrees, but not those that only remove them. Added removal to that classification and wired the existing real-source census into required tests. No production cleanup changed. Function-wide presence of guard and log names still permits wrong-path matches; this repair improves detection only.

Changed surface command: `node atris/receipts/work-folder-scan-group-probe.js --require-protection`

Exit code: 0. Actual output:
```text
boundary.worktreePath: detected
boundary.gitDir: detected
boundary.quarantine: detected
boundary.sandboxRoot: detected
group: 4 recursive targets; 0 missing from scan; source only, no folders removed
```

Rerunnable verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`

Exit code: 0. Actual output excerpt:
```text
✔ grouped sandbox cleanup exposes every recursive target to the scan (55.921375ms)
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3028.358292
```

Progress: grouped recursive targets detected rose from 1/4 to 4/4; required checks rose from 25 to 26. No removal was executed by the source probe.

Startup command `atris brain activate --root . --verify` exited 2 in plan-only mode; generated policy files were not written.

next_push: bind each ordinary removal to its own guard and log paths while preserving the counted sandbox group contract.

layer: capabilities
