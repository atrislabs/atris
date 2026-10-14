# Folder protection baseline

Fresh inspection found that this checkout does not contain the wider protection described by earlier mission receipts. No removal behavior changed.

Verdict: proceed-with-changes. The single risk is treating a passing old test set as proof that Git activity protects every cleanup path. Before changing cleanup, add a real Git fixture with an aged index.lock and confirm that the folder survives, the exact lock path and age are reported, and no removal line is written.

Evidence:
- lib/member-tidy.js:215 calls git worktree remove directly and does not record the removal through recordWorktreeRemoval.
- lib/fleet.js:2464 disposes the review folder through forced Git removal followed by recursive filesystem removal, without checking Git activity.
- commands/land.js:691 uses direct Git removal and records successful removal, but has no Git-activity check at that boundary.
- test/worktree-removal-guard.test.js contains four process/removal-log cases. test/member-tidy.test.js contains four tidy cases. Neither exercises an index.lock or paused Git operation.
- The checkout already contained an unrelated edit in bin/atris.js, which was preserved and excluded from this receipt's commit.

Plan: real locked-folder fixture -> keep with lock path and age -> shared guarded removal -> removal log.

Commands run: git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris task list --status open; atris mission goal --json; atris brain activate --root . --verify; atris; targeted code and navigation reads; git branch --list; git diff --stat.
Brain activation returned exit 2 with a plan to write missing compiled files. No writes were requested. Mission goal returned no candidate. No mission settings changed.

Verify command: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit code: 0
Actual output excerpt:
```
✔ tidy removes landed clean copies and leaves everything else to git and the rules (976.522ms)
✔ reap sees a real live process in the folder without being told (329.613458ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
ℹ duration_ms 2435.844584
```
The tests invoke real Git repositories, cleanup functions, and live process detection. No CLI behavior was changed.

Files edited: atris/receipts/2026-10-14-folder-protection-baseline.md; atris/team/architect/logs/2026-10-14.md.
Progress: one fresh baseline and one concrete coverage gap, eight passing checks, zero behavior changes.
next_push: Add a real aged Git-lock fixture to member cleanup, then require keeping the folder with its exact lock path and age and no removal log entry.
layer: beliefs
