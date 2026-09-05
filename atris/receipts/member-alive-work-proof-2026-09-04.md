# Member work proof

Owned by: backend-feature-owner. Executed by: Codex. Parent owns independent review and landing.

Task MAP-3, internal id `01M1Q5YGW61YW6ZPDBJY1YW6ZP`, is ready for review.

## Observed problem and change

The parent's cloud probe received `action: mission_started` without any executed work. The dispatcher previously reported completion and the alive wrapper substituted its wake receipt as proof. Creation alone now returns planned status, executed false, and no execution receipt. The outer loop keeps planned status and records the attempt as nonproductive. No automatic second run was added.

The next cloud probe returned `action: mission_run`, outer `ok: true`, zero ran ticks, and an errored Claude tick. The dispatcher now detects failed/errored mission tick statuses, Claude/Atris2 failure flags, and the last mission tick error. It preserves the reason and available detail. The outer loop now records an unsuccessful alive result as failed, rather than losing that failure in its summary.

Ordinary successful execution, including execution following a mission-start response, still completes with its own receipt. Existing waiting and dry-run behavior remains covered. Engine compatibility, model settings, scheduling, live files, and billing are outside this change.

## Verification

`node --test test/member-alive.test.js`: exit 0, 13 passed, 0 failed.

The process-level fixture runs the actual dispatcher and actual member alive command with a controlled final CLI. It emits pretty mission-start JSON with no work artifact and a wake-only receipt, then asserts planned status, no execution receipt, executed false, and nonproductive state. Another fixture reproduces the exact successful-envelope/errored-tick shape and asserts failed/nonproductive state. A start followed by a real execution-result fixture retains successful completion and its own receipt.

`node --test --test-name-pattern='member alive|member run' test/commands.test.js`: exit 0, 9 passed, 0 failed.

`git diff --check`: exit 0. All evidence is local with a controlled final work boundary, not a cloud execution claim. No push, publish, deployment, or live edit was performed in this slice.
