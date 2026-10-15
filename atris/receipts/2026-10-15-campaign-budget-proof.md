# Optional local campaign budget proof

Local starts without a budget now have explicit regression coverage; the frozen verifier passed with exit 0.

Files edited: test/campaign-command.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/validator/logs/2026-10-15.md. Artifacts: atris/receipts/2026-10-15-campaign-budget-proof.md and atris/receipts/2026-10-15-campaign-budget-runtime.txt.

Scope: tests and documentation only, no runtime edits or dependency changes. Local start, show and list suppress money lines; JSON start persists across processes; cloud starts fail in text and JSON before judge execution or storage.

Plan: existing behavior -> isolated test assertions -> real CLI -> frozen verifier -> proof.

## Rerun

```sh
cd /tmp/atris-cli-campaign && grep -qiE 'without --budget|no budget' test/campaign-command.test.js && git diff --quiet HEAD -- test/fixtures/campaign lib/campaign-schema.js && /opt/homebrew/bin/node --test test/campaign-command.test.js test/campaign-loop.test.js test/campaign-conformance.test.js && bash /tmp/campaign-judges/budget-optional.sh
```

Exit: 0. Exact final output:

```text
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
local runs without a budget, cloud still needs one, tests pass
```

Real CLI command output and exit codes are in 2026-10-15-campaign-budget-runtime.txt. Local start, show and list exited 0; cloud start exited 2 with `a cloud campaign needs --budget <dollars>, so the cloud knows what it may spend`.

Progress: all 25 tests across the three requested files pass, campaign judge passes, schema and fixtures unchanged against HEAD. git diff --check exited 0.

The prep brief was missing the latest implementation: HEAD already supports an omitted local budget. Both checkout paths refer to the same directory, and the specified Node exists (v24.2.0). No schema change was needed. Coverage does not certify cloud execution or spending policy beyond start refusal.

Task: CCM-1, owner validator. Existing mission attach-task was busy under the active harness, so a dedicated test task records proof without changing the mission. Member source-edit restriction was superseded only for the tests explicitly requested by the operator. No self-acceptance.

next_push: Add a regression proving that giving a local campaign a budget restores its money lines.
layer: capabilities
