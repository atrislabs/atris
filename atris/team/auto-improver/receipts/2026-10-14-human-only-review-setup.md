The safe review check now launches eleven commands instead of twelve. The focused check and all 35 required tests passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface, before and after:
`node --test --test-name-pattern='task review-lane-drain picks safe agent action without mutating human accept rows' test/commands.test.js`

Before, exit 0:
✔ task review-lane-drain picks safe agent action without mutating human accept rows (2281.101041ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 2481.314292

After, exit 0:
✔ task review-lane-drain picks safe agent action without mutating human accept rows (2254.634458ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 2452.774791

Frozen check:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11226.688375

Metric: one fewer setup CLI launch, twelve to eleven (8.3%). A single timing sample does not establish a stable speedup. Human-only creation stays at its original point, retaining title, tag, distinct goal and workspace through the real store. The connection closes before CLI certification and refusal checks. Every behavior assertion is unchanged. Downstream map references shift by four lines.

Commands/artifacts: git status --short; atris; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c; atris mission goal --json (no candidate); atris task list/new/claim/note/ready; git diff --check; atris brain activate --root . --verify and atris brain compile --root . (plan only). The generated isolated TODO is restored to its inherited version to avoid removing unrelated rows. Task ready repeats both checks with /opt/homebrew/bin/node because the recorder uses an older interpreter. Work moves to Review without self-acceptance, then is committed and pushed.

Proof artifact: atris/runs/2026-10-14-task-aic-6-2026-10-14T20-13-36-322Z.json. Task ready reran both checks, exit 0, and moved the work to Review. The absolute interpreter path requires independent review before automatic certification.

Lesson: preserve the human-only fixture's separate goal when moving creation in process, otherwise the safe continuation can mask the refusal branch.

next_push: Seed the first creation-only task in the adjacent safe review action check, keeping action execution and refusal checks on the CLI.
layer: capabilities
