# Folder protection can refer to the wrong folder

A read-only comparison confirmed that the source check accepts a delete when its guard and removal log refer to another folder. The matching-folder control passed. This measures a check weakness, not a demonstrated production deletion, and makes the next repair concrete.

Plan: synthetic matched/mismatched paths -> actual source scanner -> save advisory finding.

Files edited: atris/receipts/work-folder-scan-binding-probe.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md.
Artifact: atris/receipts/work-folder-scan-binding-2026-10-14.md.

Changed surface: `node atris/receipts/work-folder-scan-binding-probe.js`
Exit: 0. Actual output:
```text
matching folder control: detected 1, bypasses 0; required 1, 0
unrelated folder protection: detected 1, bypasses 0; required 1, 1
review gaps: 1; advisory only, synthetic source never executed
```
The advisory command reports the gap; exit zero does not mean the gap is repaired. Synthetic deletes are never executed.

Rerunnable verification: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual output excerpt:
```text
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2640.162541
```

Progress: one previously unmeasured false-certification case reproduced, with one matching control and all 25 required tests passing. No production behavior changed.
Learned: function-wide name presence cannot prove that the deleted folder is the checked and logged folder. A repair must preserve valid aggregate sandbox cleanup, which checks multiple stores before deleting them and logs the parent operation.

next_push: design a check that binds guard and log paths to the removed folder while retaining valid aggregate sandbox cleanup.

layer: capabilities
