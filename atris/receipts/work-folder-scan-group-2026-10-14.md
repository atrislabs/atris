# Grouped cleanup coverage measured

Added a read-only census of actual grouped cleanup; the probe ran with exit 0 and all 25 required tests passed with exit 0.

Verdict: proceed-with-changes. The named risk is incomplete group certification: the scanner finds the work-folder removal but misses the Git store, quarantine store, and parent sandbox removals. A count-checked group contract cannot cover these targets until detection includes them. This is a source-check gap, not a demonstrated runtime deletion bypass.

Plan: actual cleanup targets -> complete detection -> explicit grouped guard/log contract -> path binding. Require the new probe's acceptance mode to pass before claiming complete grouped coverage. It compares actual source lines, including both the Git removal and raw work-folder removal separately, so finding the Git call cannot stand in for finding the recursive delete. Keep the existing runtime lock tests and pinned setup exemptions.

Files edited: `atris/receipts/work-folder-scan-group-probe.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/architect/logs/2026-10-14.md`, this receipt. No production cleanup changed.

Changed surface command: `node atris/receipts/work-folder-scan-group-probe.js`
Actual output, exit 0:
```text
boundary.worktreePath: detected
boundary.gitDir: missed
boundary.quarantine: missed
boundary.sandboxRoot: missed
group: 4 recursive targets; 3 missing from scan; source only, no folders removed
```
Acceptance command: `node atris/receipts/work-folder-scan-group-probe.js --require-protection`. Same output, exit 1 as expected for the measured gap. Advisory exit 0 means the census ran, not that detection is repaired. Cleanup source is never executed by the probe.

Rerunnable verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Actual output excerpt, exit 0:
```text
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2576.867084
```

Progress: four actual recursive targets measured, one detected and three missed. Previous folder-binding examples did not measure grouped target coverage.

next_push: detect all four grouped sandbox removal targets before enforcing their shared guard and log contract.

layer: capabilities
