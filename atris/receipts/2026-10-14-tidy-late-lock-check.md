Member cleanup now names late lock files and ages after Git refuses removal, verified by seven real CLI timing cases and 30 passing checks, exit 0.

Files edited: lib/member-tidy.js; test/member-tidy.test.js; atris/receipts/2026-10-14-tidy-vanishing-folder-check.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md. Artifact: this receipt.

Plan: passing activity check -> late locks -> real Git refusal -> fresh activity check -> exact paths and ages -> retain folder and branch.

Real surface command: node atris/receipts/2026-10-14-tidy-vanishing-folder-check.js
It invokes node bin/atris.js member tidy --dir <generated copies> against disposable real repositories with a forwarding Git executable. Exit: 0.
Output excerpt:
```
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-5GXLht/refused/repo/.git/worktrees/landed-copy/locked (7200s old)
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-5GXLht/refused/repo/.git/worktrees/landed-copy/index.lock (10800s old)
retained lock: /private/var/folders/t1/2_4kmb5n4c71dxm26zc8dgzr0000gn/T/atris-tidy-vanishing-5GXLht/refused/repo/.git/packed-refs.lock (14400s old)
all seven timing cases passed; Git refusal after a passing check named three locks and distinct ages; files, locks, branches, and Git records retained; no removal recorded
```

Rerun: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0. Exact summary: tests 30; pass 30; fail 0; cancelled 0; skipped 0; todo 0.
Other commands: atris brain activate --root . --verify; atris; git status --short; atris mission status mission-2026-10-14-continue-work-folder-protect-04f87dc9; atris mission goal --json; atris task list; atris task new/claim/note/ready; git diff --check; atris brain compile --root .; git add; git commit; git push.
Brain activation and compilation returned exit 2, plan only, and wrote no files. No native goal candidate was offered. Existing unrelated edits remain intact.
Metric: one additional timing case, three late locks named with distinct ages, zero removals recorded, 30 checks pass. No dependencies or protected new filenames.
Learning: Git refusal can expose locks created after a passing activity scan; rescan before composing the kept-folder explanation.
Landing: committed and pushed to the current remote branch. Review transition did not succeed: the automatic task rerun returned exit 1, 17 pass and 13 fail, despite the direct frozen invocation returning exit 0 with 30 pass. Failure artifact: atris/runs/2026-10-14-task-acw-43-2026-10-14T21-50-26-141Z.json. Task remains claimed; no acceptance or merge performed.
next_push: Explain and fix the difference between direct passing checks and the failed automatic review rerun.
layer: behaviors
