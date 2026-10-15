# Earlier removal repairs stay covered

Three saved examples now cover a recursive delete with a path built by a call, a function listing work folders directly through Git, and a function using the listing parser. The normal required checks already run this probe, so these earlier repairs cannot silently lose coverage.

Plan: saved examples -> real source scanner -> required tests.

Files edited: atris/receipts/work-folder-scan-probe.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md. Artifact: atris/receipts/work-folder-scan-path-list-2026-10-14.md.

Changed-surface command: `node atris/receipts/work-folder-scan-probe.js --require-protection`
Exit: 0. Actual output excerpt:
```text
nested generic path removal: detected 1, bypasses 1; required 1, 1
direct git-list generic removal: detected 1, bypasses 1; required 1, 1
parsed git-list generic removal: detected 1, bypasses 1; required 1, 1
review gaps: 0; synthetic source only, no folders removed
```

Rerunnable verify command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0. Actual output excerpt:
```text
✔ saved scanner examples reject missed removals in the required checks (64.48425ms)
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 2831.456209
```

Progress: saved cases increased from 13 to 16; zero missed patterns, 25 passing tests. No production behavior changed. The previous failure text reported an unavailable engine verification pass, rather than a failing assertion; this direct invocation completed successfully.

Learned: nested-path and Git-list repairs had passed earlier checks but lacked saved examples in the normal acceptance probe.

next_push: review whether an unrelated guard call in the same function can falsely certify a folder delete, using a read-only source example.

layer: capabilities
