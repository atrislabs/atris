# Bulk accept --all cap fixture setup

Picked from a timed run of the whole command test file: 437 pass, 0 fail, 185.5s. After the proof-command check, the slowest was the bulk accept --all cap check at 6.4s.

That check launched the CLI 60 times to add, claim and ready 20 rows. Row 0 keeps CLI add and claim. Rows 1 to 19 are added and claimed through the same SQLite steps. All 20 still go through CLI ready.

Why ready stays on the CLI: a probe showed CLI ready writes a result trace into the ready event that the direct store step does not. The bulk accept code reads that trace to find touched files, so skipping it could change the decision. The add and claim rows and events matched the CLI ones apart from the row number.

Focused command: `node --test --test-name-pattern='task auto-accept-certified --all sweeps past the old 12-row cap' test/commands.test.js`

Three alternating runs each, all exit 0, pass 1 fail 0 skipped 0.

Before: 6.39s, 6.44s, 6.78s. After: 3.47s, 3.37s, 3.35s. Median 6.44s -> 3.37s, about 48% faster, 38 fewer launches.

Frozen check: `git diff --check` exit 0.

next_push: the slowest checks outside this file, starting with the land and autoland test files.
layer: capabilities
