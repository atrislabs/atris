# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-216]** Ship launch post: post linkedin-post.md, capture URL in journal, delete the file

## In Progress

- **[CLI-200]** Auto-improver: Recurring log pattern: Next tick will stop until a human looks at the error. [auto-improver]
  **Claimed by:** keshavrao

## Review

- **[CLI-224]** task day header: review count inflated by failed+unreviewed-done; show lane truth [tasks]
- **[CLI-223]** skill audit: no-xml-tags flags placeholders inside code blocks (9 skills false-FAIL) [cli-ux]
- **[CLI-222]** Revalidate 8 stale feature packs: heal drifted line refs, rerun rubric checks, bump last_compiled [wiki]
- **[CLI-221]** Recompile stale wiki pages that feed agent boot (systems/atris-cli, overview brief, concepts) [wiki]
- **[CLI-220]** Heal workspace drift: 82 stale MAP.md refs + archive 33 old journals via atris clean [maintenance]
- **[CLI-219]** task day: collapse failed tasks older than 7 days into one summary line [tasks]
- **[CLI-218]** Boot panel reads task projection truth (backlog/active/review) instead of stale TODO.md parse [cli-ux]
- **[CLI-217]** Policy hint false positive: VERIFY_COMMAND_PATTERN misses grep/diff-style verifiers [rsi]
- **[CLI-215]** Mine 139 career XP receipts + 317 episodes + 12 scorecards into policy lessons; prove one before/after agent behavior change with receipts [rsi]
- **[CLI-214]** Refresh business goals source of truth: live MRR/customer snapshot into wiki goals page, replacing historical 0.6-confidence numbers [business]
- **[CLI-213]** Review lane self-drain cadence: wire review-lane-run into always-on loop; receipt proves queue drains agent-side to certified with zero human turns [mission]
- **[CLI-212]** Dogfood two parallel mission start --worktree loops; fix cross-worktree mission status rollup friction [mission]
- **[CLI-199]** Auto-improver: Recurring log pattern: check: `node bin/atris.js loop --dry-run --json` now reports # stale... [auto-improver]

## Blocked

- **[CLI-162]** Refresh control packets after b20be master advance [review]
- **[CLI-161]** Refresh certified review acceptance packet after BCK-339 [review]
- **[CLI-160]** Refresh certified review acceptance packet after BCK-334 [review]
- **[CLI-89]** Dogfood business computer lifecycle with proof-backed AgentXP loop [computer]
- **[CLI-88]** AgentXP Mode first rep: complete one proof-backed customer-motion mission [agent-xp]
- **[CLI-62]** Emit Career XP game event on accepted proof [career-xp]
- **[CLI-52]** Send the following message to Pranav: 'Hey Pranav, here are some great vegan restaurant recommendations in San Francisco [agent]

## Completed

- **[CLI-211]** mission start --worktree: isolated checkout with clean baseline [mission]
  **Verify:** node --test test/mission-worktree-start.test.js
- **[CLI-210]** Evidence-aware review queue and risky-first accept-group spot-check [task-plane]
  **Verify:** node --test test/task-receipt-evidence.test.js
- **[CLI-209]** Surface validated receipt evidence in review queue and accept [task-plane]
  **Verify:** node --test test/task-receipt-evidence.test.js
- **[CLI-208]** Stop receipts and completion gate visibility in mission status [mission]
  **Verify:** node --test test/mission-stop-receipt.test.js
- **[CLI-207]** Prune mission baseline sidecar on close with audit summary [mission]
  **Verify:** node --test test/mission-baseline-lifecycle.test.js
- **[CLI-206]** Gate mission complete behind passing verifier proof [mission]
  **Verify:** node --test test/mission-complete-guard.test.js
- **[CLI-205]** Baseline mission receipts against mission-start snapshot [mission]
  **Verify:** node --test test/mission-worktree-baseline.test.js
- **[CLI-204]** Wiki loop: recompile stale jack-dorsey page [wiki]
  **Verify:** git diff --check

(194 older completed tasks archived in `atris task list --status done` and `atris task events`.)
