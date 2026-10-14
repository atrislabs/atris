# Mission startup resource proof

Startup failures now have real regression coverage for exactly one paired final reading, verified by 93 passing checks, exit 0. Runtime behavior already passed; this is proof coverage, not a failing-first repair.

Files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, this receipt.

Command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`
Runtime: Node 25.6.1. Exit: 0.

The test invokes the real mission CLI through both local runners in a temporary workspace. Codex has an executable with a missing interpreter; Claude passes its help probe and removes its temporary executable before the real spawn. Both retain start/end with the same run id, load and duration, without a kill signal, cause, or timeout. The exact two-line assertion catches duplicate error/close recordings.

```text
codex startup failure CLI exit 0: {"at":"2026-10-14T15:12:41.684Z","phase":"end","engine":"codex","task":"mission-2026-10-14-codex-startup-failure-readin-874b9274","free_pct":78,"swap_used_mb":null,"swap_total_mb":null,"load":[3.41,3.54,4.38],"run_id":"03e0704d-55db-442b-a1a9-22fb4a199539","duration_ms":10}
claude startup failure CLI exit 0: {"at":"2026-10-14T15:12:42.174Z","phase":"end","engine":"claude","task":"mission-2026-10-14-claude-startup-failure-readi-8f9ea9e2","free_pct":78,"swap_used_mb":null,"swap_total_mb":null,"load":[3.41,3.54,4.38],"run_id":"2f3cba1a-652b-408b-9a62-172e0cc63bc0","duration_ms":2}
ℹ tests 93
ℹ suites 0
ℹ pass 93
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 8079.673708
```

Initial checks rejected the Claude fixture before startup, then exposed that CLI JSON and the receipt omit the original spawn error text. The corrected assertion checks the errored result and executable absence; no implementation changes were needed.

Independent review approved; targeted real CLI check passed, exit 0: `node --test --test-name-pattern='mission runners record paired readings' test/engine-resource.test.js`.

Review gate: plain `node` selected an older installation and failed four existing CLI checks, exit 1. Explicit `/opt/homebrew/bin/node --test test/engine-resource.test.js test/engine-dispatch.test.js` passed, exit 0; task moved to Review. Supported runtime remains Node 25.6.1.

Plan: startup failure -> one final reading -> frozen checks -> review -> push.

next_push: preserve the original mission runner startup error in its saved result so operators can see why it failed.
layer: capabilities
