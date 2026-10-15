Soul-help checks now run together; the focused test and required health tests passed, exit 0.

Files changed: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.
Plan: independent help reads -> unchanged assertions -> focused and frozen proof.
Safety: commands/soul.js:312-315 returns before workspace discovery; assertions still reject workspace or home state creation. Promise.all finishes all successful reads before cleanup.

Rerun the changed surface:
node --test --test-name-pattern='^soul help prints usage without workspace state$' test/commands.test.js
Before output: ✔ soul help prints usage without workspace state (1712.283542ms); tests 1, pass 1, fail 0; exit 0.
After output: ✔ soul help prints usage without workspace state (1196.064917ms); tests 1, pass 1, fail 0; exit 0.

Frozen verifier:
node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js
Output: tests 35, pass 35, fail 0, cancelled 0, skipped 0, todo 0; duration_ms 22681.354917; exit 0.

Metric: three sequential launch stages become one; all three real CLI launches and all assertions remain. Single timing samples are not a stable speedup claim.
Workspace commands: atris brain activate --root . --verify; atris; atris mission status mission-2026-10-14-continue-speeding-up-slow-te-d2899d4e; atris mission goal --json; atris task list; git status --short; atris task new/claim/note/ready; atris brain compile --root .; git diff --check; git commit; git push. Brain commands reported plan only, exit 2; no generated policy files changed. No native goal candidate was returned. Existing log and TODO changes remain unstaged.
next_push: batch the three independent learn-help reads after confirming they return before state creation.
layer: capabilities
