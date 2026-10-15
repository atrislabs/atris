The launch recording check now follows omitted literal and outer alias defaults. Both required test files passed, exit 0.

Files edited: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt. Task commands also updated the rendered TODO; that file and pre-existing changes to commands/scout.js and lib/fleet.js are excluded from staging.

Verify command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Actual output excerpt:
```
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
tests 148
suites 0
pass 148
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 37092.766166
```
Exit: 0. The required suite exercised the real recording check and the existing real process and CLI paths.

Progress: 38 new regression assertions cover four helper forms, omitted second arguments, nested callers, profiles, body shadowing, supplied plain programs and null, unrelated defaults, recorded launches, and help probes. A Node VM replay with the old parameter matching fails the first new assertion: actual [], expected ['commands/planted.js:2 runner']; replay command exit 0 confirms the expected regression was reproduced.

Additional checks: `node --test --test-name-pattern='every engine started through' test/engine-resource.test.js`, exit 0, one matching test passed. `git diff --check`, exit 0, no output. `node bin/atris.js slop detect --diff`, exit 0: clean, no slop tells in 7 files. Both navigation maps were updated to the moved test starts; the required suite checked their references.

Scope: resolver calls in defaults and explicit undefined arguments remain outside this bounded text scan. No production launch behavior or dependencies changed. Brain activation and compilation returned a plan with exit 2; no generated policy files were written. The mission has no native goal candidate.

Review: independent Fable review passed, exit 0, 123006 ms, no blocking findings within scope. It traced the implementation and real file shapes but could not run Node in its session; the direct local required suite supplies runtime proof. Receipt: atris/runs/engine-ask-20261015004410869-907-ae138696.json. Local output: /tmp/executor-tick-31-review.json. Engine calls: 1, retries: 0, token usage unknown.

Readiness: the first ready command passed its diff check but rejected the landing sentence. Corrected the sentence; readiness passed with git diff --check, exit 0, and the task moved to Review without self-acceptance. Readiness receipt: atris/runs/2026-10-15-task-ecm-15-2026-10-15T00-45-44-920Z.json. Required behavioral verification was run directly once; readiness did not repeat it. Safe internal changes are committed and pushed separately from unrelated existing edits.
next_push: Recognize engine resolver calls in omitted runner defaults using balanced function parameter boundaries.
layer: capabilities
