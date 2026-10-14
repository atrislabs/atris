The review lane drain API check went from about 2.43s to 0.50s. Its five review rows now reach review through the task store instead of ten command launches. It passed five runs, a planted bug in the continue work rule failed it on the first drain read, and the 35 required checks passed, exit 0.

Files edited: test/commands.test.js; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; atris/team/auto-improver/receipts/2026-10-14-review-lane-drain-api-store-seeded.md.

Rerunnable verification command:
`/opt/homebrew/bin/node --test --test-name-pattern='^task serve exposes review-lane-drain API$' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Ran bare. Actual output excerpt:
```text
✔ task serve exposes review-lane-drain API (509.376291ms)
✔ task serve exposes review-lane-drain API (488.827666ms)
✔ task serve exposes review-lane-drain API (489.095667ms)
✔ task serve exposes review-lane-drain API (501.075666ms)
✔ task serve exposes review-lane-drain API (500.954791ms)
verifier exit=0
ℹ tests 35
ℹ pass 35
ℹ fail 0
map refs: nothing to move.
```

How the target was picked: all four checks that start a task server were timed. Review lane drain 2313ms, task factory API 1631ms, continue work 725ms, generic next rejection 224ms. The drain check was slowest and still had ten setup launches.

Change: five rows each ran ready then review only so the drain, act, loop and run requests had review state to read. They now make the same two store calls those commands make, in one helper. Every server request is unchanged, and the one show run after the review lane run still goes through the CLI.

Why it is safe: a scratch script ran ready and review both ways on fresh stores, with and without a next task. Once timestamps, traces and versions were set aside, status, claim, every metadata field and the latest event type matched exactly. The only gap at first was the result sentence the test launcher adds to every ready run, so the helper passes the same sentence.

Cost: the ready command's policy gates and saved snapshot file no longer run for these five rows. Other checks cover ready and review directly.

Proof the check still bites: the rule that picks continue work when a reviewed task names a next task was patched to always pick waiting on a human. The check failed on the first drain read (expected continue work, got waiting on a human), right after the seeded rows. The source was restored from git and checked clean.

Metric: three runs before: 2439ms, 2434ms, 2429ms. Five runs after: 489ms to 509ms. Ten fewer command launches.

Map refs: 41 refs shifted 26 lines from the diff, each matched by line content, 0 mismatches.

next_push: Take the continue work server check (725ms), count its setup launches, and move the ones that only seed review state to the task store.
layer: capabilities
