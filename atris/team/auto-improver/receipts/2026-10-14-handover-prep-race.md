# Handover prep check no longer fails on a busy machine

The required checks failed once in the harness because the stalling engine in the handover prep test was killed by its one-second limit before it could log that it started. The check now proves that launch through the run record instead; a scratch copy that reproduces the exact failure passes with the new check and fails with the old one, and all 35 required checks pass, exit 0.

Files: `test/roster-prep-brief.test.js`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-14.md`, and this receipt.

Cause: the harness receipt for the failed run shows the call log as claude then cursor-agent, with devin missing, and the test took 2731 ms. The fake devin logs its call on its first line, but the one-second cap is real wall time around a shell launch, so under load the kill can land first. The run record rows, which the product writes, already require devin stalled before the backup landed.

Change: the call log must show the prep then the backup in order, and devin must be first whenever it did log. The check that devin never got the brief, the prompt check on the backup, and the three run record rows are unchanged.

Commands run:
- Scratch copy with a devin fake that never logs, new check: exit 0, `✔ a handover backup preps only when its own line asks (3801.390666ms)`.
- Same scratch copy, old check: exit 1, `actual: [ 'claude', 'cursor-agent' ]`, matching the harness failure. Both scratch files were deleted.
- `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`, exit 0, run without a pipe.

Required-check output excerpt:
```
✔ a handover backup preps only when its own line asks (3673.748834ms)
ℹ tests 35
ℹ pass 35
ℹ fail 0
```

Not reproduced naturally: four full runs and six single-test runs under CPU load all passed before the fix, so the proof rests on the forced race, not on a natural repeat.

next_push: In the test where task status resolves goal display references, create only the parent task in process and keep the child creation on the CLI.

layer: capabilities
