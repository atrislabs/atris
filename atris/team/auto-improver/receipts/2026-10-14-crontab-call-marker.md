The status test now detects command calls directly; its real CLI check passed, exit 0, and all 35 required checks passed, exit 0.

Files edited: test/autoland.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md. Task commands also regenerated atris/TODO.md.
Artifact: atris/team/auto-improver/receipts/2026-10-14-crontab-call-marker.md.
Plan: fake crontab call -> marker -> real status CLI -> marker absent.
Verify: node --test --test-name-pattern='autoland status never probes crontab' test/autoland.test.js
Output: ✔ autoland status never probes crontab (142.158917ms); tests 1; pass 1; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 226.635416. Exit 0.
Required: node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35; pass 35; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 10072.154084. Exit 0.
Metric: removed one three-second fake sleep and one 1.5-second pass threshold; no elapsed-time assertions remain in this case. Successful runtime savings are not claimed, because the fake command was already never called.
Lesson: prove a forbidden subprocess call with a marker rather than a timing limit; a fast accidental call must fail too. Marker environment is scoped to the CLI child.
Review: submitted proof without self-accept. Changes committed and pushed to the existing branch.

Proof recording: atris task new, claim, note, and ready were run. The first ready attempt rejected its result wording; the next used an older Node and failed with ERR_UNKNOWN_BUILTIN_MODULE for node:sqlite. Ready then passed with /opt/homebrew/Cellar/node/25.6.1/bin/node --test --test-name-pattern='autoland status never probes crontab' test/autoland.test.js, exit 0, and saved atris/runs/2026-10-14-task-aic-6-2026-10-14T15-43-43-523Z.json. Independent review remains pending. git diff --check passed, exit 0. atris brain activate --root . --verify and atris brain compile --root . returned plan-only exit 2, no brain files were written.
next_push: Replace the 700ms fixed wait in test/member-board-this-project.test.js with polling for the expected board output.
layer: capabilities
