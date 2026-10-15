The unknown one-word command test now skips the full workspace setup, about 0.34s to 0.10s, and it now checks that no file at all is added, not just that the to-do list is unchanged; it passed three runs, a CLI mutant that left a stray state file failed the new check, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-unknown-command-test-without-init.md.

Rerunnable verification command:
`node --test --test-name-pattern='^unknown single-word command exits 2' test/commands.test.js && node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
unknown command test exit=0
ℹ tests 1
ℹ pass 1
ℹ fail 0
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
doc-health exit=0
```

Mutation: the CLI was patched to write a state file before refusing the unknown word. The test failed, listing the three extra paths under the hidden state folder. The old check compared only the to-do list, so it would have passed. The CLI was restored from git and checked clean.

Metric: one init launch removed. Three runs before: 336ms, 341ms, 354ms. Three runs after: 95ms, 96ms, 98ms.

Why it is safe: the CLI decides a word is unknown before it reads any workspace file. The only workspace check on the path that adds work is whether the atris folder exists, so the test writes that folder, a real map, and a fixed to-do list. The workspace then counts as started, the same as after init, and the refusal is checked against it. File paths are normalized so the listing check holds on any platform.

Commands and artifacts: atris mission status; git status; reading the unknown word branch, the interactive entry, and the workspace state check; three timed runs before and after; a CI platform check; the CLI mutant run and restore; the test; frozen verifier; four line refs moved up two lines in MAP-NOTES, with range ends checked; atris doc-health (exit 0); atris slop detect.

next_push: Take the next init test whose checks read only what it writes from the remaining 14; the two review mode tests are the next to check.
layer: capabilities
