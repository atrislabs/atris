The approval scorecard check creates setup records without launching two extra commands. The changed check and all required checks passed, exit 0.

Files: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface, before and after:
`node --test --test-name-pattern='brain scorecard carries task landing quality and human outcome' test/commands.test.js`

Before, exit 0:
✔ brain scorecard carries task landing quality and human outcome (1179.01525ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1314.227292

After, exit 0:
✔ brain scorecard carries task landing quality and human outcome (924.934834ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1056.048875

Frozen check, exit 0:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10039.19825

Metric: setup launches reduced by two; total CLI launches nine to seven (22%). Focused test runtime 1179.01525 ms before, 924.934834 ms after (single samples, no timing threshold). Every existing assertion remains; claim, ready, accept, revise and scorecard run the real CLI. Each task is seeded at its original point with the original title and approval tag.

Lesson: preserve original creation points when replacing setup launches, so the approval and revision paths see the same task population. Reuse the ordered seed helper and close the store before launching the CLI.

State note: mission attach-task refused because its lock is held by pid 51811; a dedicated task was created, claimed, and marked ready instead. Brain activation and compilation reported plan-only; no generated policy files were changed.

Review recording: initial ready rejected a descriptive proof because it required running the checks itself. Its bare node command selected an older Node lacking node:sqlite (exit 1); explicit /opt/homebrew/bin/node ran both checks successfully (exit 0). Task is in Review and was not self-accepted. Recorded output:

  not probed: the command reaches an absolute path (/opt/homebrew/bin/node), so running it away from this checkout proves nothing
✓ verified: `/opt/homebrew/bin/node --test --test-name-pattern='brain scorecard carries task landing quality and human outcome' test/commands.test.js && /opt/homebrew/bin/node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js` exited 0 (receipt atris/runs/2026-10-14-task-aic-1-2026-10-14T20-02-59-942Z.json)
ready for approval AIC-1 v4
Result trace recorded.
proof is ready; this verifier needs a second agent review because autoland cannot rerun it.
note: this verify command is outside the auto-certify allowlist, so autoland cannot run the second check itself. use a test command like node --test <file> or git diff --check, or have a second agent run: atris task review-chat AIC-1 --as <reviewer>

The generated TODO view was restored to its initial contents because this isolated task database rendered away unrelated inherited rows; task truth remains in the task database.

next_push: Replace the setup-only add in the latest-review scorecard regression with real-store creation, retaining done, review, scorecard and compile CLI checks.
layer: capabilities
