
## Saved recovery commit check
Saved backup listings now withhold restore commands when the saved commit reference is missing. The real CLI checks passed in ordinary and quoted folders, and recovery still passed after replacing the reference.
Files: commands/land.js; test/worktree-removal-guard.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md.
Verify: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js && node bin/atris.js slop --staged
Output: tests 92; pass 92; fail 0; skipped 0; todo 0; clean, no slop tells in 4 files. Exit: 0.
Real surface: node bin/atris.js land --backups and node bin/atris.js land --backups --json, executed in disposable repositories by the tests. Both exited 0; missing-reference output says "cannot restore: saved commit is missing" and JSON returns restore: null.
Learned: checking the saved reference itself catches a missing recovery name even while the underlying commit remains reachable through a reflog.
next_push: Record backup input paths and identify missing patch files before offering recovery.
layer: capabilities
