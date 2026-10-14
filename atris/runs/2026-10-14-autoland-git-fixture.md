Landing tests now copy a pristine real Git repository instead of rebuilding it for each fixture. Verified with sequential real runs of `node --test test/autoland.test.js`, all passing.

Files edited: `test/autoland.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt, `atris/runs/2026-10-14-autoland-git-fixture.md`.

Root cause: 43 fixtures repeated five Git initialization/configuration/add/commit subprocesses, 215 setup calls. A lazy pristine template reduces initialization to five calls per process. Each fixture uses a complete filesystem copy, without shared refs, object files, config or task state. Suite-scope cleanup removes only the generated template. The added real-Git regression changes one fixture and checks another's history, branch list, config, file state and database path.

All 67 original tests and assertions remain. One new isolation regression brings the passing total to 68. Only one test file changed. Baseline and final runs used the same inherited PATH and environment, sequentially, without overlapping our test runs. Shared machine load can vary; this is an observed comparison, not a fixed speed guarantee.

Progress: baseline 62960.255667 ms; final runs 38167.300125 and 31055.753709 ms, about 39% and 51% faster. Average final duration is 34611.526917 ms, about 45% faster.

Rerun: `node --test test/autoland.test.js`. Frozen check: `git diff --check`.

before:
```text
$ node --test test/autoland.test.js
ℹ tests 67
ℹ suites 0
ℹ pass 67
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 62960.255667
exit code: 0
```

after 1:
```text
$ node --test test/autoland.test.js
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38167.300125
exit code: 0
```

after 2:
```text
$ node --test test/autoland.test.js
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 31055.753709
exit code: 0
```

Development checks: initial template cleanup ran at the first test boundary and caused ENOENT failures. Moving the cleanup registration to module scope fixed that. The first isolation regression also needed to recreate its task folder after switching branches. Both final full runs include the corrected regression and pass.

Brain activation and compile commands returned exit 2, plan-only, because generated brain files are absent. No unrelated generated policy files were written. The pre-existing rendered `atris/TODO.md` change was preserved and excluded from this commit.

```text
$ git diff --check
(no output)
exit code: 0
```

next_push: Profile repeated task certification CLI startup in the landing test file and remove one setup cost while preserving real certification coverage.
layer: capabilities
