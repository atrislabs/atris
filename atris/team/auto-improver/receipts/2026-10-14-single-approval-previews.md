# Single approval previews run together

The single-row approval test runs its JSON and text previews together; all eight alternating focused runs and all 35 required checks passed, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

The two preview launches now take one turn instead of two. Every original assertion remains, including the post-preview read proving review status. Creation, readiness, review, strict verification and final acceptance remain sequential. Dry runs build their own projections from SQLite and do not consume the shared display file. Existing edits in `lib/task-db.js`, `test/landing-proof.test.js` and the generated TODO view were preserved and excluded. Timing comparisons include the same existing task-store edits in both versions.

## Proof

Rerun: `node --test --test-name-pattern='^task auto-accept-certified requires explicit human confirmation$' test/commands.test.js`

Four runs per version alternated with pair order reversed. Means: 1832.788ms before, 1737.661ms after, a 95.128ms (5.2%) local reduction. This does not claim a suite-wide speedup.

```
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1912.851625ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1723.338542ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1712.026292ms)
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1784.480833ms)
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1774.445ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1760.338625ms)
after: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1754.938916ms)
before: exit 0; ✔ task auto-accept-certified requires explicit human confirmation (1859.375875ms)
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
ℹ duration_ms 13376.098458
```
Exit code: 0.

Additional checks: `git diff --check` passed, exit 0. Brain activation and compilation returned exit 2, plan only; missing compiled inputs were not regenerated as unrelated policy changes.

Review handoff: readiness reran the focused test with `/opt/homebrew/bin/node`, exit 0, and placed the task in review. Automatic second review cannot rerun this absolute-path command; independent review remains pending. The initial landing sentence was rejected, then a clearer sentence passed. No acceptance or merge was run. The change was committed and pushed.

next_push: batch the missing-actor and malformed-actor refusal checks in the same approval test after proving both return before database writes.
layer: capabilities
