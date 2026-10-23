# Parallel one-lap runtime tests

Date: 2026-10-22 America/Los_Angeles.

The 22 real one-lap cases now run across five balanced files with one shared fixture. This is one implementation increment, not completion of the broader speed mission. No production code, dependencies, or excluded tests changed. No merge is authorized or performed.

## Plan and rollback

```text
22 sequential cases -> shared isolated fixture + five files -> exact-body comparison -> real runtime checks
```

Rollback: restore the declared paths from `e2c38a8a721151cee1b2cbe12755bb02bcd76ae9` and remove only the new files from this increment.

## Changed files

- `test/one-lap-runtime.test.js`: retains four real cases and the frozen command's existing filename.
- `test/one-lap-runtime-2.test.js` through `test/one-lap-runtime-5.test.js`: remaining eighteen cases, with their original Mac-only platform skip.
- `test/helpers/one-lap-runtime.js`: the original fixture, relocated imports/root and named exports only. No top-level tests or fixture creation.
- `.github/workflows/macos-sandbox.yml`: wildcard includes all five files in the real Mac sandbox run.
- `atris/MAP.md`, `atris/refs/MAP-NOTES.md`: route split files and repair moved references.
- This receipt; local member log `atris/team/validator/logs/2026-10-22.md` is intentionally uncommitted, as required by the repository hook.

The fast-test list did not name this file. The CI shard balance guard passes with the new files. Linux skips these Mac-only cases, so no Mac runtime measurements were inserted into the Linux GitHub duration weights.

## What the prep brief lacked

The exact previous failure was missing. Mission status identifies a 120-second harness limit, not a failing assertion. Before the split, a fresh bare `node --test test/one-lap-runtime.test.js` passed all 22 cases, zero skipped, exit 0, duration 206546.301167 ms. The immutable mission check now runs only the four retained cases; it no longer covers all 22. The wildcard command below is required for full coverage. The mission check and policy were not modified.

## Preservation proof

Compared against `e2c38a8a721151cee1b2cbe12755bb02bcd76ae9` using a Python script extracting each top-level `test(` block, trimming surrounding blank lines only. The sorted original and resulting lists match exactly, including assertions, names, timeouts, and cleanup: 22/22, each appearing once. The helper matches the entire original pre-test prefix after only removal of the test import/platform gate, relocation of the agent-env import/repo root, and addition of exports. Every split file retains the identical platform gate. Both excluded files match HEAD byte for byte.

Original runtime-file SHA-256: `77d98f5e31b6404fb5d78fc0af6fc52e29be0cb376f946f066cd1e8ea1316e7e`.

Local evidence: `.atris/state/test-suite-speed/split-manifest.json` records each full test block's SHA-256 and destination. Per-file groups use summed baseline timings, not reduced waits:

| File | Cases | Baseline case time (ms) |
| --- | ---: | ---: |
| `test/one-lap-runtime.test.js` | 4 | 58006 |
| `test/one-lap-runtime-2.test.js` | 4 | 57791 |
| `test/one-lap-runtime-3.test.js` | 5 | 63738 |
| `test/one-lap-runtime-4.test.js` | 4 | 57594 |
| `test/one-lap-runtime-5.test.js` | 5 | 62923 |

The new helper is discovered as a file by bare Node test discovery. This can increase the reported total by one file-only result, without adding a behavior check; compare named cases as well as totals in the eventual full-suite after run.

## Actual verification

Rerun command, invoked bare without a pipeline:

```sh
/usr/bin/time -p node --test test/one-lap-runtime*.test.js test/ci-test-shard.test.js test/map-refs-accurate.test.js > .atris/state/test-suite-speed/split.log 2>&1
```

```text
exit 0
tests 27
suites 0
pass 27
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 62864.800416
real 62.89
user 93.13
sys 133.36
```

All 22 runtime case names match the original exactly; the other five are shard discovery/balance/error handling and map-link checks. The shard error-handling case intentionally launches one failing child test; its child failure is expected, and the overall process exits 0. The first map check found four stale moved references, which were repaired before this final run.

The runtime file alone took 206.55 seconds on the fresh pre-split rerun. The split files plus five guards took 62.89 seconds, about 69.6% less elapsed time. This is a targeted run comparison, not a full-suite speed measurement. Individual cases take longer under parallel load, as expected; their original deadlines were preserved.

`git diff --check`: exit 0, no output. Local complete log: `.atris/state/test-suite-speed/split.log`; exit status: `.atris/state/test-suite-speed/split.exit`.

Log SHA-256: `7a466fc0981b67f05276a40a67ef9da726defa2f8c99d4941f25ca6ef7ea6824`.

`atris brain activate --root . --verify` and `atris brain compile --root .` both returned exit 2 with a plan-only message requesting `--yes`. No generated policy/adapters were changed as part of this test-only slice.

The task proof recorder also reran `/opt/homebrew/Cellar/node/24.2.0/bin/node --test test/one-lap-runtime*.test.js test/ci-test-shard.test.js test/map-refs-accurate.test.js` and exited 0. Its local receipt is `atris/runs/2026-10-23-task-vmt-2-2026-10-23T03-06-18-669Z.json`. An absolute executable avoids the known login-shell Node version mismatch. The task is in Review; automatic certification cannot rerun an absolute executable outside its allowlist, so independent review is still needed. No acceptance, merge, or policy override was attempted.

## Broader mission still required

The committed baseline receipt records bare full-suite wall time 480.23 seconds, 6852 passed, 6 failed, 6858 total. That is unchanged evidence, not an after measurement. A full-suite after run and comparison of the six exact failing names have not been performed in this increment. Five intentional production break-and-revert proofs, any further splits, and the final pull request with full before/after numbers remain pending. No end-to-end speed or no-new-failures claim is made yet.

next_push: split the slow autoland cases into balanced parallel files with unchanged bodies, then complete five deliberate break-and-revert checks across moved cases and measure the full suite before opening the final pull request.

layer: capabilities
