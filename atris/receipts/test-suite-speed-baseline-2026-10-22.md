# Test suite speed baseline

Date: 2026-10-22 America/Los_Angeles (run completed 2026-10-23 UTC).

This increment records the untouched suite before any test split. No production or test files changed. The mission remains in progress; after timing, five deliberate break-and-revert checks, and the final pull request are still pending.

## Plan

```text
unchanged test files -> timed full suite -> required runtime check -> saved baseline
```

Rollback: remove this receipt and its navigation row; retain local measurement logs for the next increment.

## Full suite before

- Revision: `1128333d78453c0ca3dbe770b7b641a0d0964fef`.
- Node: `v24.2.0`; logical CPUs: `10`.
- Starting uptime: `7 days, 19:33`; load averages: `2.29 2.66 5.53`.
- Ending load averages: `5.03 8.97 8.52`.
- The task command regenerated `atris/TODO.md` during the run; that generated change was restored. Test and production files stayed untouched.
- Exact invocation (no pipe):

```sh
/usr/bin/time -p node --test > /tmp/atris-suite-speed-20261023/before.log 2>&1
```

```text
exit 1
tests 6858
suites 22
pass 6852
fail 6
cancelled 0
skipped 0
todo 0
duration_ms 480197.857291
real 480.23
user 1241.11
sys 670.52
```

The log also contains an intentionally failing child suite from the shard runner test. Its child summary is not the full-suite result above.

### Existing failures

- `test/engine-resource.test.js:2568:1`: youtube notes in auto mode show a killed writer's cause on screen before the fallback line.
- `test/lesson-gate.test.js:113:3`: throws when all candidates match a resolved lesson.
- `test/lesson-gate.test.js:150:3`: throws when all candidates match a pass lesson without tagging it resolved.
- `test/lesson-gate.test.js:180:3`: throws when all candidates match a pre-tagged resolved lesson.
- `test/runner-command.test.js:335:1`: buildRunnerCommand shell-quotes allowedTools in the default command shape.
- `test/runner-command.test.js:381:1`: buildRunnerCommand omits --allowedTools when not given.

These six failures predate any optimization. Compare failing test identities as well as totals after splitting. The runner-command cases expect Claude flags but receive a Codex command; the lesson-gate cases report an untrusted-directory Codex failure; the engine-resource case reads `signal` from a missing result. They were not repaired in this increment.

## Saved local evidence

- `.atris/state/test-suite-speed/before.log`: complete output and wall timing.
- Log SHA-256: `9d078ce1598b956c4a04763dd19feca5ce5011e5f6f40b2b42d3d22c2cb5d901`.
- `.atris/state/test-suite-speed/before.exit`: `1`.
- `.atris/state/test-suite-speed/before-summary.json`: counts, failure identities, environment and individual one-lap durations.
- `.atris/state/test-suite-speed/before-inventory.json`: exact top-level test declaration lines and SHA-256 fingerprints, saved before test edits.

The local evidence stays with this checkout and is not committed. The summary and untouched Git revision above make the baseline reviewable without those local files.

| Original file | Top-level tests | SHA-256 |
| --- | ---: | --- |
| `test/one-lap-runtime.test.js` | 22 | `77d98f5e31b6404fb5d78fc0af6fc52e29be0cb376f946f066cd1e8ea1316e7e` |
| `test/autoland.test.js` | 69 | `fbd966483f4f42569e0e520886aa1cab608950af61c8a5435032f62e895e33c1` |
| `test/commands-5.test.js` | 20 | `7e3ff30275211383e469770329e14c2c9f1199228d0e361a76444ccf58ba9489` |
| `test/commands-6.test.js` | 40 | `add944c0229ea711699ef8367d0c35393fda11f205ec4a763ba1ad687f6bddb5` |
| `test/gm-bet.test.js` | 56 | `e5503a0ee7f8b79f834c841b0f9f318163ccf874cef78784fc6c6393dca79cd9` |
| `test/gm-phone.test.js` | 25 | `0be7fb85a951d39eb811a8ee3b3999b7442095215229e099934a322362ef7bb1` |

All 22 one-lap cases passed during the full suite. Their summed case time was 300,052.449 ms, so this file is a useful first target for parallel execution.

## Required runtime check

Rerun: `node --test test/one-lap-runtime.test.js`.

Actual invocation (no pipe):

```sh
/usr/bin/time -p node --test test/one-lap-runtime.test.js > /tmp/atris-suite-speed-20261023/frozen.log 2>&1
```

```text
exit 0
tests 22
suites 0
pass 22
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 228340.837
real 228.38
user 82.28
sys 109.50
```

Complete output: `.atris/state/test-suite-speed/frozen.log`; exit status: `.atris/state/test-suite-speed/frozen.exit`. The six saved test-file fingerprints still match after both runs. The standalone check is a separate observation and is not an after-optimization measurement.

## Next increment

next_push: split the 22 one-lap cases into independent test files using one shared fixture, preserve their bodies and platform skips, retain real cases in the original file, and add every new file to the Mac sandbox workflow. Use the saved case timings to balance the groups. Then compare exact test names, run the new files and full suite, and perform five break-and-revert proofs before opening the final pull request.

The prep brief lacked baseline measurements and authentication status; both were checked here. GitHub authentication is available. Attaching the mission task was refused because the active parent runner holds the mission lock, so a separate local baseline task records this increment without changing mission policy.

layer: capabilities
