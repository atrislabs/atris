The safe review selection check now launches twelve commands instead of thirteen. The focused test and all 35 required tests passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface, before and after:
`node --test --test-name-pattern='task review-lane-drain picks safe agent action without mutating human accept rows' test/commands.test.js`

Before, exit 0:
✔ task review-lane-drain picks safe agent action without mutating human accept rows (3906.921417ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 4223.617583

After, exit 0:
✔ task review-lane-drain picks safe agent action without mutating human accept rows (4082.519208ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 4347.264625

Frozen check:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16505.802542

Metric: one fewer CLI setup launch, thirteen to twelve (7.7%). Runtime increased in this single sample; no stable speedup is claimed. Waiting task creation stays at its original point, retaining title, tag, goal and workspace through the real store. The store closes before ready, review and before/after reads exercise the CLI. Every behavior assertion is unchanged. Downstream map references shift by three lines.

Commands and artifacts: atris; git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c; atris mission goal --json (no candidate); atris task list/new/claim/note/ready; git diff --check; atris brain activate --root . --verify and atris brain compile --root . (plan only). Missing generated brain files remain absent. Task ready reruns both checks with /opt/homebrew/bin/node, because the recorder uses an older interpreter. The generated isolated TODO is restored to its inherited version to avoid removing unrelated rows. Work goes to Review without self-acceptance and is committed and pushed.

Proof artifact: atris/runs/2026-10-14-task-aic-5-2026-10-14T20-11-45-328Z.json. Task ready reran both checks, exit 0, and moved the work to Review. Its absolute interpreter path requires independent review before automatic certification.

Lesson: a second setup fixture can use a separate short-lived real database connection at the original creation point, preserving ordering and CLI coverage without sharing a live connection across child processes.

next_push: Seed the human-only task creation in the same safe review selection check, preserving its distinct goal and CLI refusal checks.
layer: capabilities
