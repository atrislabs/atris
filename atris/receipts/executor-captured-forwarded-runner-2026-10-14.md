The launch check now follows forwarded engine runners captured by nested helpers. Both required test files passed, exit 0.

Changed files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt.

Verify command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Output excerpt:
```
tests 148
suites 0
pass 148
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 40714.658167
```
Exit: 0. Full captured output: /tmp/executor-tick-30-tests.txt.
Real repository scan: 5 launches by name and 8 engine launches through variables, 0 unrecorded.

Progress: 23 new regression assertions cover four nested helper forms, profile members, recorded runs, help probes, unrelated programs, and parameter shadowing. Alias lookup now retains the declaration position so a captured copy resolves against the parameter visible where the copy was made. No dependencies added.

Regression proof: executed the new guard assertions with the original sourceAt and engineSourceAt in a Node VM. The original check returned [] for a missing recording; the expected result was ["commands/planted.js:3 runner"]. The updated real guard passes. The initial targeted test pattern matched no test; the corrected `node --test --test-name-pattern='every engine started through' test/engine-resource.test.js` ran and passed the actual guard, exit 0.

Additional commands: `git diff --check`, exit 0, no output; `node bin/atris.js slop detect --diff`, exit 0, clean with no slop tells in 7 files before this receipt. Navigation references updated to the moved test starts and validated by the required suite.

Mission task attachment was unavailable because the running mission holds its lock. A dedicated task was created and claimed instead. Existing unrelated edits in commands/scout.js, lib/fleet.js, and atris/TODO.md are excluded from staging. Brain activation and compilation reported planned generated files with exit 2; no generated policy files were written.

Readiness: the first ready command rejected its result wording before verification. Reworded the result and reran with the documented supported-runtime prefix; exit 0, task in Review. Readiness receipt: atris/runs/2026-10-15-task-ecm-14-2026-10-15T00-41-35-493Z.json. Automatic certification cannot rerun the prefixed command, so acceptance remains pending; no task was self-accepted.

Review: Fable (claude-fable-5-1) returned PASS, exit 0, after 186390 ms. It traced the current implementation and all new shapes, with no blocking findings; its tools did not include a shell, so it did not inspect the git diff or rerun tests. Review receipt: atris/runs/engine-ask-20261015003707276-70549-eada2ffa.json. Local review capture: /tmp/executor-tick-30-review.json. Engine calls: 1; retries: 0; token usage unknown.
next_push: Recognize engine runner defaults when a caller omits the runner argument.
layer: capabilities
