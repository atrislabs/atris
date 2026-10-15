# Bulk approval setup shares one connection

The bulk approval test reuses one setup connection, with ten alternating focused runs passing and all 35 required checks passing, exit 0.

Files edited: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

## Change and scope

Twenty setup opens and closes become one. The connection closes in finally before the final real CLI ready call. Titles, ordering, claim and ready assertions, the CLI ready call, all three CLI preview scans, and every scan assertion stay unchanged. No production code changes. Existing uncommitted edits in lib/task-db.js and test/landing-proof.test.js were preserved and excluded from this commit; measurements include that same existing store optimization in both versions. The generated TODO view is excluded.

## Proof

Rerun: `node --test --test-name-pattern='^task auto-accept-certified --all sweeps past the old 12-row cap$' test/commands.test.js`

Five focused runs before and five after passed. The first sequential comparison was noisy and slower after the change (480ms versus 506ms), so ten alternating runs followed, reversing order each pair. Their means were 519.303ms before and 499.524ms after, a 19.779ms (3.8%) reduction. This is a small local measurement, not a broad suite speed claim. Connection count drops 95% regardless of timing noise.

Alternating run output (each exit 0):
```
after: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (508.672ms)
before: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (525.58525ms)
before: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (522.625959ms)
after: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (507.335417ms)
after: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (507.813542ms)
before: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (518.576625ms)
before: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (518.195916ms)
after: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (483.439584ms)
after: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (490.360125ms)
before: ✔ task auto-accept-certified --all sweeps past the old 12-row cap (511.530916ms)
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
ℹ duration_ms 13444.892875
```
Exit code: 0.

Additional commands: `git diff --check` (exit 0); `atris brain activate --root . --verify` (exit 2, plan only); `atris brain compile --root .` (exit 0, plan only). Compiled brain inputs are absent in this checkout; no generated policy changes were applied.

Review handoff: the first ready call required its own verifier invocation (exit 2). Its unqualified Node invocation then selected an older runtime without node:sqlite (exit 1). Repeating with `/opt/homebrew/bin/node --test --test-name-pattern='^task auto-accept-certified --all sweeps past the old 12-row cap$' test/commands.test.js` passed, exit 0, and moved AIC-2 to review. That absolute path is outside automatic review's allowlist, so human or independent review remains pending. No task acceptance was run.

next_push: measure and batch independent reads in the remaining single-row approval preview test.
layer: capabilities
