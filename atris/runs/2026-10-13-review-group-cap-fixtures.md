# Review-group cap fixture setup

The review-group cap check made twelve tasks with four CLI launches each, 48 launches before any real check ran. The first task keeps that full CLI path. The other eleven go through the same SQLite steps the CLI uses: add, claim, ready with the fixture result sentence, review.

Equivalence probe: one task made through the CLI and one seeded directly, in the same database. The rows matched apart from title, and the event history matched step for step (created, claimed, proof_ready, reviewed, same actors). Every grouping, limit and all-groups assertion still runs through the real CLI, and the "twelve finished things" check fails if any seeded row is missing.

Focused command: `node --test --test-name-pattern='task review groups are capped by default for human scan' test/commands.test.js`

Three alternating runs each, all exit 0, pass 1 fail 0 skipped 0.

Before: 6.89s, 7.24s, 8.93s. After: 1.25s, 1.23s, 1.59s. Median 7.24s -> 1.25s, about 83% faster.

Frozen check: `git diff --check` exit 0.

next_push: time the next slowest single tests inside the command test file and pick the one with the most repeated CLI setup.
layer: capabilities
