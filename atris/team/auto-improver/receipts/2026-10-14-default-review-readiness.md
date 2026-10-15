# Default review readiness setup

Review screen testing now uses two command launches instead of three; the focused test and required health tests passed, exit 0.

- files: test/commands.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/auto-improver/logs/2026-10-14.md, and this receipt.
- change: production readyTask seeds readiness in the fixture connection with the same actor and proof and the standard fixture result; success is asserted and the connection closes in finally before CLI certification and screen checks. Every existing screen assertion remains.
- metric: three CLI launches become two. Focused samples: 496.222541ms before, 325.455792ms after, without a stable timing claim.
- focused command: `node --test --test-name-pattern='^review default mode leads with certified accept like first-minute$' test/commands.test.js`
- focused output: `✔ review default mode leads with certified accept like first-minute (325.455792ms)`; tests 1, pass 1, fail 0, duration_ms 466.149459, exit 0.
- frozen command: `node --test test/stall-signal-health.test.js test/roster-prep-brief.test.js test/roster-run-record.test.js`
- frozen output: tests 35, pass 35, fail 0, duration_ms 14515.16775, exit 0.
- state commands: atris; brain activate and compile (plan-only, exit 2); mission status and goal (no candidate); task list/new/claim/note/ready; git status/diff/log/remote, diff --check, commit and push.
- artifacts: this receipt, updated map pointers, member log entry and task proof ready for review.
- approval proof: the first ready attempt rejected independently run proof; reran the focused test through task ready with /opt/homebrew/bin/node, exit 0. Proof is in review; the absolute runtime path requires a second review for automatic certification.
- review: diff retains CLI certification and review rendering, preserves original proof and actor, checks setup success, and closes before child processes run. No runtime behavior or dependencies changed.
- unrelated edits: lib/task-db.js, test/landing-proof.test.js, rendered TODO and earlier member log edits are preserved and excluded from this commit.
- next_push: inspect the sync preview test for setup-only readiness that can use the production store while retaining its sync CLI assertions.

layer: capabilities
