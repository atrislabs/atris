# Member run cases share one prepared repository

The two member run cases now copy one prepared repository that already has git set up and a created member. Each case still adds its own files and makes its own single baseline commit, so the repository each run sees matches what it saw before. Every run, worktree, and isolation assertion remains.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, this receipt, and `atris/team/auto-improver/logs/2026-10-14.md`.

Metric: setup launches across the two cases drop from eight (three git calls and one CLI launch each) to four. Three alternating runs of the old and new file, both cases together: 12.66s vs 12.25s, 12.65s vs 12.64s, 12.53s vs 12.19s. That is about 0.3s, roughly 2%, because nearly all of each case is the member run itself.

Map upkeep: line references after the edit moved by ten lines. The shift only touched references whose line still matched, five help-check rows that had drifted in earlier ticks now point at their tests by name, and the reference repair tool moved one unrelated drifted task-database reference.

Proof:
- `node --test --test-name-pattern='^member run (starts a budgeted isolated mission from plain text|chooses useful work from params)' test/commands.test.js`: exit 0, `tests 2`, `pass 2`, `fail 0`.
- `node --test test/roster-run-record.test.js && node bin/atris.js slop --staged`: see the member log entry for this tick.

next_push: the member run cases spend most of their time on about 49 git calls inside the run. Check whether the stale-worktree scan and repeated clean-tree checks inside a one-tick member run can be skipped or cached, which would help real runs too.
layer: capabilities
