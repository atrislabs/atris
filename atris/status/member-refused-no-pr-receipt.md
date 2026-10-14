Turned-down member work now stays local, verified by the frozen test and a separate real handoff command.

Files edited: lib/member-autoland.js; test/member-refused-no-pr.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md.
Artifact: atris/status/member-refused-no-pr-receipt.md.

Commands: atris; git status --short; atris mission status mission-2026-10-14-turned-down-member-work-does-4f0da01a; atris brain activate --root . --verify (plan only, exit 2); atris mission goal --json; atris task list; task show CLI-1359 (not found); mission attach-task (active driver lock held, no mutation); task new, claim and note ATD-1. Task state in this checkout had no existing row, so a local proof task was created without changing the mission.

Verify: `node --test test/member-refused-no-pr.test.js`
Exit: 0
Output excerpt:
```text
real handoff command exit 0: left the branch for you: a linked task was turned down; it needs fresh proof before it can go to github
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

Runtime command: the fourth test invokes Node with the real member-autoland module, task database, and Git in a temporary repository. Git remote calls and gh calls are recorded by traps. None occurred. This checks the changed handoff itself without opening an external change. The exact rerunnable process invocation is in test/member-refused-no-pr.test.js.

Landing: committed and pushed to origin; no pull request was opened. The local task is in review after task ready reran the frozen test successfully (exit 0). The mission is held by its active parent driver, so its state was left for that driver to finalize. Brain activate and compile both returned plan-only exit 2; generated policy files were not written. Git diff --check passed.

Metric: four passing checks; zero remote or GitHub calls for refused work. Fresh proof changes approval back to pending and still stops at the existing missing-review gate.

Plan: linked task -> current approval -> hold or existing review gates.
Rollback: revert this bounded commit.
next_push: Show the send-back reason beside the held GitHub handoff.
layer: behaviors
