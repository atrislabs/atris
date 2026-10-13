# Dispatch remote fixture follow-up

## Failure and fix

`fleet dispatch from a worktree records the build in the main checkout`, in
`test/roster-runs-worktree.test.js:145`, failed at its landed-length assertion:
actual 0, expected 1. Its fixture had a real committed HEAD and no origin, so
`localDispatchBase` selected the new local proof-only path. The fake build
directory supplied no Git change for local Review, and remote landing did not run.

The test intends remote landing and recording history in the main checkout.
It now clones its fixture into a local bare origin, registers that origin, and
fetches it. All existing assertions remain unchanged. Production code is unchanged.

## Fixture audit

No other existing test unintentionally changed dispatch mode because origin was
absent. Checked every `runDispatchFlight` caller in `test/` and the CLI callers:

- `roster-run-record.test.js`, `roster-prep-brief.test.js`,
  `roster-coverage-gaps.test.js`, `stall-handover.test.js`, and
  `stall-signal-health.test.js` initialize repositories without a HEAD commit.
  An absent origin alone does not enable local dispatch.
- `engine-dispatch.test.js` and `fleet.test.js` dispatch from non-Git temp roots.
  The committed main-branch resolver fixture in `engine-dispatch.test.js` has
  origin; its separate origin-free boundary fixture has no HEAD.
- `dispatch-scout.test.js` has committed origin-free build checkouts, but
  dispatch's launcher is a separate non-Git receipt directory. Selection is
  based on that launcher, so its dispatch behavior did not change.
- `fleet-task-ready.test.js` already configures origin.
- The other dispatch in `roster-runs-worktree.test.js` explicitly sets
  `reviewOnly: true`, which bypasses local-mode selection.
- `engine-dispatch-no-origin.test.js` intentionally covers the new local mode,
  including its yolo case; these are new tests, not accidentally changed fixtures.
- One-lap runtime dispatch explicitly requests review-only mode. Engine command
  error tests stop at argument validation before dispatch.

## Verification

Node v25.6.1. Plan: reproduce failure -> add fixture origin -> rerun file ->
run full suite -> rerun any failing file alone -> commit locally, without push.

Before fix: `env -i HOME=$HOME PATH=$PATH node --test test/roster-runs-worktree.test.js`
exited 1: tests 8, pass 7, fail 1, cancelled 0, skipped 0, todo 0.

After fix: the same command exited 0: tests 8, pass 8, fail 0, cancelled 0,
skipped 0, todo 0.

Full suite command: `env -i HOME=$HOME PATH=$PATH node --test`, without pipes or
test filters. Output is captured at `/tmp/atris-dispatch-no-origin-full-suite.log`.
Exit 0, with exact final output:

```text
ℹ tests 5483
ℹ suites 22
ℹ pass 5483
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 375997.699083
```

No failures or load flakes occurred; no isolated failure reruns were needed.
`git diff --check` also exited 0 with no output.

Changed files: the test fixture, its route in `atris/MAP.md`, its file:line pointer
in `atris/refs/MAP-NOTES.md`, and this receipt. The generated task view is kept out
of the commit; task ownership and proof remain in the local Atris task store.
