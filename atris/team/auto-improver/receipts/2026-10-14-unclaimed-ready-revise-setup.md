# Faster unclaimed ready revise check setup

The check that revising ready work nobody claimed returns it to open now launches one fewer command, four down to three; the changed test and all 35 required checks passed, exit 0.

Files: `test/commands.test.js`, `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Plan: real-store creation -> unchanged CLI ready, revise and claim -> required checks -> review.

The fixture creates an open, unclaimed task in the real task database, resolves its display reference and closes in finally before the CLI ready. The open status and missing owner after revise, and the claimed status after the follow-up claim, are unchanged.

Metric: four CLI launches become three, a 25% reduction. One observed run of the changed test took 602.639167 ms; there is no matched before timing, so no speed claim beyond the launch count.

Commands run:
- `node --test --test-name-pattern='task revise returns unclaimed ready work to open' test/commands.test.js`, exit 0, run without a pipe.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Changed-surface output:
```
✔ task revise returns unclaimed ready work to open so agents can claim it (602.639167ms)
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

next_push: Remove the creation launch in the test where revise refuses accepted work so rewards stay current, keeping its claim, ready, accept and refusal checks.

layer: capabilities
