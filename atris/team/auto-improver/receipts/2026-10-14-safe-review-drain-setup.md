The safe review selection check launches thirteen commands instead of fourteen. The focused check and all 35 required tests passed, exit 0.

Files edited: test/commands.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/auto-improver/logs/2026-10-14.md; this receipt.

Changed surface command, before and after:
`node --test --test-name-pattern='task review-lane-drain picks safe agent action without mutating human accept rows' test/commands.test.js`

Before, exit 0:
✔ task review-lane-drain picks safe agent action without mutating human accept rows (6526.456541ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 6826.233709

After, exit 0:
✔ task review-lane-drain picks safe agent action without mutating human accept rows (4044.244083ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 4293.739292

Frozen check command:
`node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`

Output excerpt, exit 0:
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 15848.388917

Metric: one fewer setup launch, fourteen to thirteen (7.1%). A single timing sample improved; no stable runtime speedup is claimed. Every original behavior assertion remains. Real-store creation retains title, tag, workspace and goal link; the store closes before certification, drain, text alias and before/after human-gate reads run through the CLI. Downstream mapped test references shifted by seven lines.

Commands and artifacts: git status --short; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-f4a7db0c; atris task list; atris; atris mission goal --json (no candidate); atris task new/claim/note/ready; git diff --check (exit 0); atris brain activate --root . --verify and atris brain compile --root . (plan only). Missing brain files were not generated. The inherited TODO view is preserved because isolated task rendering would remove unrelated rows. Task ready invokes both checks again using /opt/homebrew/bin/node to avoid the older interpreter used by the recorder. Work goes to Review without self-acceptance and is committed and pushed.

Proof artifact: atris/runs/2026-10-14-task-aic-4-2026-10-14T20-09-37-382Z.json. Task ready reran both checks, exit 0, and moved AIC-4 to Review without acceptance; the absolute interpreter command requires independent review before automatic certification.

Lesson: seed only setup data through the real store, preserve the goal link that selection consumes, and retain CLI certification and the nonmutation reads.

next_push: Seed the waiting-for-human task creation in the same safe review selection check, keeping ready, review and before/after reads on the CLI.
layer: capabilities
