# Cleanup map pointers

Member cleanup pointers now name the exact guard, missing-folder check, removal record, and lock scanner. The source-and-map check passed, and the frozen check passed all 25 tests with exit 0.

Changed files:
- atris/refs/MAP-NOTES.md
- atris/receipts/2026-10-14-tidy-map-check.js
- atris/receipts/2026-10-14-tidy-map-check.md
- atris/team/architect/logs/2026-10-14.md

Proof command: `node atris/receipts/2026-10-14-tidy-map-check.js`
Exit: 0
Output:
```text
lib/member-tidy.js:160: exact source and map match
lib/member-tidy.js:195: exact source and map match
lib/member-tidy.js:199: exact source and map match
lib/member-tidy.js:218: exact source and map match
lib/git-activity.js:7: exact source and map match
```

Real surface: `node bin/atris.js doc-health`, exit 0.
Output excerpt: `map refs: 989 right, 28 moved, 3 unclear, 0 gone`.

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Exit: 0
Output excerpt:
```text
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Progress: two misplaced cleanup pointers corrected, the bare scanner line replaced with an exact file pointer, three helper anchors added, and five exact source lines checked. The health checker tolerates nearby references, so its moved count stays at 28. Its right count grew by one because the scanner now has a file pointer.

Task attachment was attempted with `atris mission attach-task 27 --json`, exit 3, and reported a busy lock. No lock was changed. Existing changes in bin/atris.js and atris/TODO.md were preserved and excluded from staging. Brain activation was plan-only, exit 2; generated policy files were not written. An initial inline pointer check incorrectly expected the replaced line 198 to remain in the map, exited 1, and was corrected to check line 199 in the saved proof.

next_push: Prove whether member tidy reports old private and shared locks when it keeps a copy because the branch has not landed.

layer: environment
