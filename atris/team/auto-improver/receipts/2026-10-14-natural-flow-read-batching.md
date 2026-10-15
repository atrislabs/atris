# Natural task flow reads

Natural task flow checks now run two reads together; the focused test and required health checks passed, exit 0.

- files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md and this receipt.
- change: desk and next inspect the same open task concurrently before claim; all six real CLI launches and every output, projection version and episode assertion remain.
- metric: six sequential CLI stages become five. Focused local sample: 808.146167ms before, 738.324125ms after, without claiming a stable timing gain.
- focused command: `node --test --test-name-pattern='^task natural flow creates, picks, talks, finishes, and refreshes projection$' test/commands.test.js`
- focused output: tests 1, pass 1, fail 0, duration_ms 877.898458, exit 0.
- frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
- frozen output: tests 35, pass 35, fail 0, duration_ms 14946.517041, exit 0.
- other commands: atris mission status, atris mission goal --json, atris task list --status open, task new/claim/note/ready, git diff --check (exit 0), git commit and git push.
- setup notes: brain activate and compile returned plan-only exit 2; no generated adapters were rewritten. Duplicate receipt repair setup was already optimized, so this slice followed the mission read-batching objective.
- review proof: the task runner used an older Node without node:sqlite on its first attempt (exit 1). Re-running with `/opt/homebrew/bin/node --test --test-name-pattern='^task natural flow creates, picks, talks, finishes, and refreshes projection$' test/commands.test.js` passed, exit 0.
- learned: batch desk and next only before claim so both inspect the same open state; retain the final version assertion to detect accidental mutations.
- next_push: inspect headless JSON desk and next checks for the same independent read batching opportunity.
- unrelated edits: task database, landing proof test, rendered TODO and earlier member-log edits are preserved and excluded from staging.

layer: capabilities
