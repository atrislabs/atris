# engineer playbook, 2026-07-01

Six plays, run in order. Each has exact file:line, the change, the test, and done-when. Bugs came from mission thinking/logs; context map is in atris/logs/2026/2026-07-01.md Notes.

House rules for every play: one play per PR, test first, run `node --test <touched test file>` and `git diff --check` before ready, lowercase CLI output, no em dash (U+2014) anywhere, no Co-Authored-By trailers.

## play 1: proof fallback in streams view (30 min)

- File: `commands/task.js:1177`
- Now: `proof: task.review && task.review.proof || null`
- Change to the fallback pattern already used at `commands/task.js:962`: `task.review?.proof || task.metadata?.latest_agent_proof || null`
- Test: task with empty `review.proof` and `metadata.latest_agent_proof` set renders a non-null proof in the streams tasks array of `atris task status --json`.
- Done when: no streams entry shows `proof: null` while `latest_agent_proof` exists. Example today: task 01KWE6P4JQTS8QS8VNYATS8QS8 in `.atris/state/tasks.projection.json` (streams section, around line 10548).

## play 2: one junk filter everywhere (1 hr)

- Source of truth: `isGenericInboxPlaceholder` at `lib/next-moves.js:28-31` (already blocks "test idea").
- Export it if not exported. Apply it in:
  - `commands/member.js:487` `memberRunAutoMissionText` candidate path (the filter at :487-490 is a partial local regex; replace with the shared one).
  - `commands/mission.js:1768` `chooseNextMissionTarget`: the `latestSuggestedTarget` fallback path must also pass the shared filter.
- Test: an inbox containing only "test idea" never yields a mission objective or member run target. Add to `test/moves.test.js` and `test/commands.test.js`.

## play 3: print the landing on screen (1-2 hr)

- The reasoning already exists: `missionReceiptLanding` at `commands/mission.js:912` builds `{status, changed, reason, checked, tested, proof, next}` (schema atris.result_landing.v1) but it only lands in the receipt file.
- Change: in the non-JSON output of `mission tick` and `mission run`, print the landing as six plain lines (changed / why / checked / tested / proof / next). `atris mission status` shows the last landing for each active mission.
- Test: extend `test/mission-status.test.js` (landing tests already exist there); assert the text output of a tick contains the six lines.
- Done when: an operator sees why the mission did what it did without opening any receipt file.

## play 4 (revised after live simulation): teach the chooser to resume, and stop hiding rejections

Status check first: the wider sources and near-miss report from the original play 4 ALREADY EXIST. `trustedNextMissionSource` (commands/mission.js) already trusts certified_review_next_task, endgame_backlog, wiki_status_next_ingest, mission_report, and `chooseNextMissionAnalysis` already emits `next_action_preview.near_misses` with reasons. Do not rebuild those.

What the live simulation (2026-07-01, real workspace state mirrored to a sandbox) proved is still broken:

1. No resume verb. `rejectNextMissionCandidate` marks every active mission "already handled" (correct: do not start a duplicate), but the chooser can only propose STARTING missions. On a well-run day where all work is already tracked, it always stops. Today it stopped while two active missions sat in ready status. Fix: when the top rejected candidates are active ready/planning missions, return a resume plan (`atris mission run <existing-id>`) for the highest-scoring one instead of the stop command.
2. Near-miss cap hides the interesting rejections. `nearMissPreview` slices to 3; today all 3 slots were "already handled" missions, so the fresh inbox idea's rejection ("zero value score") was invisible. Fix: group near-misses by reason, show up to 2 per reason, or raise the cap and dedupe "already handled" into a count.
3. Fresh inbox ideas die silently. Inbox is not a trusted source, so any idea whose taste score is <= 0 is rejected as "zero value score" with no path forward. Fix: when the only surviving rejections are zero-score inbox ideas, emit an ask ("promote one of these?") listing them, instead of a bare stop.

- Files: `rejectNextMissionCandidate`, `chooseNextMissionAnalysis` (~commands/mission.js:1955-1999), `nearMissPreview` (:1939), `chooseNextMissionPlan` (:2135).
- Guardrail: `test/mission-status.test.js:3688` (stop instead of placeholder) must stay green: junk-only state still stops.
- Test: state with an active ready mission and no new candidates -> plan is resume, not stop. State with only a zero-score inbox idea -> ask with the idea listed. Junk only -> stop.

## play 5: trust preflight on hourly install (2 hr)

- File: `installMemberAliveCron` at `commands/member.js:2259`.
- Change 1: before the `--execute` path, run `git status --porcelain`; if dirty, block with `reason: 'install_requires_clean_git'`, same payload shape as the existing `execute_requires_confirm_autonomy_policy` block at :2262.
- Change 2: print an "every hour this will" preview in both dry-run and real install output: member, cadence (from `memberAliveCronCadence` :2249), the mission text (from `memberRunAutoMissionText` :497), verify command, stop condition, and where receipts land.
- Test: dirty repo blocks install; dry-run output contains the preview lines. Extend the existing "member alive install dry-run writes hourly cron plan" test in `test/commands.test.js`.

## play 6: atris harvest (1 day, only after plays 1-5)

- New `commands/harvest.js`, routed in `bin/atris.js` (add to knownCommands, dispatch, showHelp).
- Scan three sources: mission receipts in `atris/runs/*.json` (landing + verifier failures + stop reasons), run logs in `atris/logs/runs/`, and `atris/thinking.md`.
- Emit plain next actions as inbox lines (`- **I#:** ...`), filtered through the shared placeholder filter from play 2. Read-only by default, `--write` appends to today's journal inbox.
- Done when: running `atris harvest` after a mission run surfaces the same class of bugs found by hand today (buried reasoning, proof mismatch, weak chooser).
