# Faster uncertified review next check setup

The check that task next points an agent at accepting reviewed work, while leaving open work alone, now launches two fewer commands, seven down to five; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation of both tasks in their original order -> unchanged CLI claim, ready, next and both shows -> required checks -> review.

Both tasks are seeded in the order the test created them, so the review task keeps the first reference. The open task now exists before the claim and ready instead of after, which changes nothing those two commands touch, since both name the review task directly. The id and both references come from the stored rows.

Metric: seven CLI launches become five, a 29% reduction. One observed run of the changed test took 896.240541 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task next names accept for uncertified review and leaves open work unclaimed' test/commands.test.js`, exit 0.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task next names accept for uncertified review and leaves open work unclaimed (896.240541ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Required-check output excerpt:
```
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

next_push: In the test where task next surfaces review debt when no open work exists, seed the review task in process and keep the claim, ready and next on the CLI.

layer: capabilities
