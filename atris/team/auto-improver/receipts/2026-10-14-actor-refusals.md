# Actor refusal checks run together

The single approval test runs its missing and malformed actor checks together; eight alternating focused runs and all 35 required checks passed, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Both actor checks explicitly confirm acceptance, so they skip standing-policy lookup and exit through the actor guard before the task store opens. Each still asserts exit 2 and human_actor_required. Every original assertion remains; later previews, reviews and acceptance retain their ordering. Unrelated existing changes in lib/task-db.js, test/landing-proof.test.js and the generated TODO view were preserved and excluded. Both comparison versions include the same existing store edits.

## Proof

Rerun: `node --test --test-name-pattern='^task auto-accept-certified requires explicit human confirmation$' test/commands.test.js`

Four runs per version, alternating and reversing pair order, averaged 1834.678ms before and 1697.782ms after: 136.896ms (7.5%) faster locally. This is a focused-test measurement, not a suite-wide claim. Two launches now take one turn.

Real output excerpts:
```
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1892.358958ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1684.762125ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1660.77475ms)
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1820.8705ms)
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1798.28075ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1707.663792ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1737.928375ms)
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1827.202ms)
```

Required command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Real output excerpt:
```
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14057.69625
```
Exit code: 0.

`git diff --check` passed, exit 0. Brain activation and compilation printed plan-only output; missing compiled inputs were left alone to avoid unrelated policy edits.

Review handoff: task readiness reran the focused test with /opt/homebrew/bin/node, exit 0, and saved the task for review. Automatic second review cannot run the absolute-path command; independent approval remains pending. No task acceptance or merge was run. The safe internal change is committed and pushed.

next_push: batch the done, finish and positive-review refusals in the proof-only guard test after confirming each exits without writes.
layer: capabilities
