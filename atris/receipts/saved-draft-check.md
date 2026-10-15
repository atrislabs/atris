Recovery now detects missing saved draft folders, verified by 92 passing tests with no failures or unfinished tests.

Files: commands/land.js, test/worktree-removal-guard.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-15.md, atris/receipts/saved-draft-check.md.

Verification: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js && node bin/atris.js slop --staged

Behavior checks exited 0: pass 92, fail 0, skipped 0, todo 0.
Real surface inside the disposable repository: node bin/atris.js land --backups
Output excerpt: cannot restore: saved draft folder is missing
Exit: 0. Plain output omits recovery; JSON returns restore null. Restoring the draft directory permits the saved command to recover staged, binary and draft bytes exactly.

Progress: one missing-backup case covered, no new files with restricted words, no dependencies added.
The existing task attachment could not run because its lock is held by another process. Existing notebook changes were preserved.
next_push: Check saved draft file contents before offering recovery when the directory still exists.
layer: capabilities
