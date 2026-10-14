Nested helper parameters now keep unrelated calls out of engine recording checks, verified by both required test files: 148 passed, zero failed, exit 0.

Files edited: test/engine-resource.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/executor/logs/2026-10-14.md; this receipt.
Generated atris/TODO.md changes were left unstaged.

Rerunnable proof: node --test test/engine-resource.test.js test/engine-dispatch.test.js
Exit: 0. Raw output: /tmp/executor-tick16-final-tests.txt.
Output excerpt:
```
real engine launch scan: 5 launches by name, 0 unrecorded
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
ℹ tests 148
ℹ suites 0
ℹ pass 148
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 64939.624667
```

Commands run: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-machine-memory-load-5ec77704; atris mission goal --json; git status; atris task list; atris mission attach-task 31 --json; atris task new, claim and note ECM-11; targeted node test; atris engine roster; atris engine fable --timeout 180 (read-only review); frozen test command; git diff --check; atris brain compile --root .; atris task ready ECM-11; git add declared files; git commit; git push.

Metric: 32 added assertions; 148 tests passed; five literal and eight variable engine launches scanned with zero missing recordings.
Before/after: the new regression failed before the fix, reporting an outer engine launch from an unrelated nested parameter call; it passed after the fix.
Initial full check: 147 passed and one failed due to moved map references. Updated references in both maps; final full check passed.
Review: Fable approved the slice by reading the changed code and assertions; its shell was disabled, so it did not execute tests. Review output: /tmp/executor-tick16-review.txt. Review receipt: atris/runs/engine-ask-20261014220706257-66301-af2b0538.json.
Learning: a matching nested parameter hides the internal name only while the call is within that helper's body; captured names and calls after the helper closes must remain visible.
Limits: matching assigned/internal names, nested declaration-name shadowing, default parameters, destructuring, and reassignment remain outside this slice.
Mission attachment was refused because the parent holds its lock; no mission settings changed. Brain activation and compilation remained previews and wrote no policy files.
Stop: one verified slice completed; ongoing mission preserved.
next_push: respect nested parameter shadowing when the assigned and internal function names match.
layer: capabilities
