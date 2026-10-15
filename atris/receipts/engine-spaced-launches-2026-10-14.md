# Spaced launches retain recording checks

The recording check now catches engine launches with spaces, tabs, or line breaks before the launch helper's opening parenthesis.

Files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt. Existing shell-warning edits and rendered task changes were preserved and excluded from the commit.

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
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

`git diff --check`: exit 0, no output. Full test output: /tmp/engine-tick59-tests.txt. Review: independent read-only review found no correctness issues. Progress: 126 new assertions across six helpers and three whitespace forms, with no dependencies added.

next_push: recognize whitespace before opening parentheses in the direct engine-name launch check.
layer: capabilities
