# Spaced direct launches retain recording checks

Direct engine launches with spaces, tabs, or line breaks before the opening parenthesis now get checked for resource recording.

Files edited: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt. Existing shell-warning edits, rendered task changes, and previous map/log edits were preserved outside this commit.

Verify command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Exit: 0
Output excerpt:
```text
real engine launch scan: 5 launches by name, 0 unrecorded
real runner and profile launch scan: 9 engine launches through a variable, 0 unrecorded
ℹ tests 151
ℹ pass 151
ℹ fail 0
ℹ skipped 0
```
Full output: /tmp/engine-tick60-tests.txt. `git diff --check` and `git diff --cached --check`: exit 0, no output.

Progress: 90 new assertions across four helpers and three spacing forms. Review: independent read-only review caught a newline source-line expectation; corrected, then review found no remaining issue. The first run failed that assertion and shifted map references; the second full run passed after both were corrected. No dependencies added.

Commands also run: mission status, mission goal --json, task list/new/claim/note, git status/diff, doc-health --fix-refs. Brain activate and compile were attempted, both returned exit 2 with a plan-only response; no generated operating files were written.

next_push: handle whitespace between resource-recording helper names and their opening parentheses in both launch guards.
layer: capabilities

Additional check: task ready reran the same command through its wrapper and returned exit 1, 129 passed and 22 failed. Its receipt contains abbreviated output only: atris/runs/2026-10-15-task-ecm-19-2026-10-15T02-57-01-621Z.json. The direct invocation above passed; the wrapper discrepancy remains unresolved and should be investigated next.
