# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** autopilot-runner-agnostic
**Picked:** 2026-06-15 23:32
**Horizon:** the autopilot/run heartbeat is engine-agnostic like missions already are — a claude -p pricing change, model retirement, or runner swap is a config flag, not a code change or a silent overnight outage
**Source:** user-prompt (Agent SDK credit-pause email surfaced the exposed flank: run.js + autopilot.js hardcode `claude -p` with no `--model`, while mission.js already resolves runner+model)

## Backlog

(Empty)

## In Progress

- **[CLI-731]** Add timeline filter display object to mission timeline JSON output [loop]
  **Claimed by:** auto-improver
- **[CLI-573]** Mission XP: work overnight and see where we can self improve. goal after goal nonstop 6 hours [agent-xp]
  **Claimed by:** auto-improver

## Review

- **[CLI-739]** Add budgeted mission contract judge to mission run [mission]
- **[CLI-738]** Mission XP: In five minutes, read the existing Atris mission docs and pick the highest-leverage next move for budgeted mission contracts: a user gives an outcome plus time budget, Atris thinks bottleneck-first, uses tasks/goals/team members, and lands in simple language. [agent-xp]
- **[CLI-737]** Add explicit paused native goal supersede mode [mission]
- **[CLI-736]** Expose paused-goal fallback sequence [mission]
- **[CLI-735]** Emit replace-goal action for paused native-only goals [mission]
- **[CLI-734]** Emit native replace-goal action for paused mission conflicts [mission]
- **[CLI-733]** Respect paused native goal in direct mission goal bridge [mission]
- **[CLI-732]** Fix direct mission run visible-goal bridge conflict [mission]
- **[CLI-730]** Add timeline navigation display object to mission timeline JSON output [loop]
- **[CLI-729]** Add timeline summary display object to mission timeline JSON output [loop]
- **[CLI-728]** Add timeline schema display object to mission timeline JSON output [loop]
- **[CLI-727]** Add timeline empty-state display object to mission timeline JSON output [loop]
- **[CLI-726]** Add timeline meta display object to mission timeline JSON output [loop]
- **[CLI-725]** Add timeline artifact display object to mission timeline JSON output [loop]
- **[CLI-724]** Add timeline prune display object to mission timeline JSON output [loop]
- **[CLI-723]** Add timeline export display object to mission timeline JSON output [loop]
- **[CLI-722]** Add timeline status display object to mission timeline JSON output [loop]
- **[CLI-721]** Add timeline actions display object to mission timeline JSON output [loop]
- **[CLI-720]** Add timeline proof display object to mission timeline JSON output [loop]
- **[CLI-719]** Add timeline item display object to mission timeline JSON output [loop]
- **[CLI-718]** Add history item display object to mission timeline JSON output [loop]
- **[CLI-717]** Add current landing display object to mission timeline JSON output [loop]
- **[CLI-716]** Add display object to mission timeline JSON output [loop]
- **[CLI-715]** Add mission display object to mission timeline JSON output [loop]
- **[CLI-714]** Add mission labels object to mission timeline JSON output [loop]
- **[CLI-713]** Add next object to mission timeline JSON output [loop]
- **[CLI-712]** Add generated object to mission timeline JSON output [loop]
- **[CLI-711]** Add artifact object to mission timeline JSON output [loop]
- **[CLI-710]** Add commands object to mission timeline JSON output [loop]
- **[CLI-709]** Add booleans object to mission timeline JSON output [loop]
- **[CLI-708]** Add counts object to mission timeline JSON output [loop]
- **[CLI-707]** Add labels object to mission timeline JSON output [loop]
- **[CLI-706]** Add currentlandinglabel to mission timeline JSON output [loop]
- **[CLI-705]** Add historylabel to mission timeline JSON output [loop]
- **[CLI-704]** Add hashistorywithoutcurrent to mission timeline JSON output [loop]
- **[CLI-703]** Add historywithoutcurrentcount to mission timeline JSON output [loop]
- **[CLI-702]** Add historywithoutcurrent to mission timeline JSON output [loop]
- **[CLI-701]** Avoid duplicating current landing in terminal history list [loop]
- **[CLI-700]** Show terminal full-history hint only when timeline is truncated [loop]
- **[CLI-699]** Add History label to mission timeline terminal output [loop]
- **[CLI-698]** Add current landing summary to mission timeline terminal output [loop]
- **[CLI-697]** Add timeline count to mission timeline markdown exports [loop]
- **[CLI-696]** Add compact timeline count to mission timeline terminal output [loop]
- **[CLI-695]** Add truncation metadata to mission timeline JSON output [loop]
- **[CLI-694]** Add nextmove to mission timeline JSON output [loop]
- **[CLI-693]** Add currentlanding to mission timeline JSON output [loop]
- **[CLI-692]** Add operator commands to mission timeline JSON output [loop]
- **[CLI-691]** Add full-history export hint to mission timeline terminal output [loop]
- **[CLI-690]** Add generated timestamp to mission timeline terminal output [loop]
- **[CLI-689]** Add generatedat to mission timeline JSON output [loop]
- **[CLI-688]** Add Generated at line to mission timeline markdown exports [loop]
- **[CLI-687]** Add Full history heading before mission timeline markdown list [loop]
- **[CLI-686]** Add Current landing section near top of mission timeline markdown exports [loop]
- **[CLI-685]** Move Operator commands near top of mission timeline markdown exports [loop]
- **[CLI-684]** Add Operator commands section to mission timeline markdown exports [loop]
- **[CLI-683]** Add a Prune preview line to mission run landing [loop]
- **[CLI-682]** Add mission timeline --prune-preview to expose prune summary without --write [loop]
- **[CLI-681]** Add compact prune summary to mission timeline JSON output [loop]
- **[CLI-680]** Show mission timeline --write prune summary in terminal output [loop]
- **[CLI-679]** Add latest prune dry-run summary to mission timeline markdown exports [loop]
- **[CLI-678]** Run mission prune-runs dry-run and record the compression summary [loop]
- **[CLI-677]** Add a prune hint to mission timeline markdown exports [loop]
- **[CLI-676]** Add an Export line to mission run landing for the full markdown timeline command [loop]
- **[CLI-675]** Add mission timeline --all so markdown exports can include full landing history [loop]
- **[CLI-674]** Add a Next move section to mission timeline markdown exports [loop]
- **[CLI-673]** Add mission timeline --write to save the landing list as a markdown report [loop]
- **[CLI-672]** Add a mission timeline hint to mission run landing after the proof path [loop]
- **[CLI-671]** Add a mission timeline command that lists saved landing changed and next lines from mission receipts [loop]
- **[CLI-670]** Save mission run create-next created or continued task details in the summary receipt [loop]
- **[CLI-669]** Make mission run create-next changed line mention the created or continued task instead of only the heartbeat [loop]
- **[CLI-668]** Show the active task in mission run create-next landing when duplicate protection skips creation [loop]
- **[CLI-667]** Add mission run create-next so a heartbeat can materialize the suggested loop task [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-666]** Add command to create and claim the suggested self-improvement task [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-665]** Make mission run landing use evidence-backed loop seed [mission]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-664]** Make self-improvement seed choose a specific target from evidence [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-663]** Write the overnight self-improvement proof timeline [proof]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-662]** Make mission run landing point at the next self-improvement seed [mission]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-661]** Show a next-task seed when loop status has only the active mission [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-660]** Hide Mission XP bookkeeping from loop next moves [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-659]** Suppress vague dogfood tick inbox placeholders from loop next moves [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-658]** Stop completed inbox ideas reappearing in loop next moves [loop]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-657]** Make task accept landing concise [task-review]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-656]** Make review tested line human-facing [task-review]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-655]** Make review saved line approval-ready [task-review]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-654]** Make review queue why-it-matters specific [task-review]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-653]** Recognize clean dry-run proof text [task-review]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-652]** Allow clean dry-run as review verifier [task-review]
  **Verify:** node bin/atris.js clean --dry-run --json
- **[CLI-651]** Heal stale MAP run pointer surfaced by clean [maintenance]
  **Verify:** git diff --check
- **[CLI-650]** Limit grouped approval queue by default [task-review]
  **Verify:** node --test test/commands.test.js
- **[CLI-649]** Run full regression after overnight proof polish [verify]
  **Verify:** npm test
- **[CLI-648]** Make no-summary always-on mission landings honest [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-647]** Make mission tick verifier line human-readable [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-646]** Keep always-on mission tick next action running [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-645]** Make mission tick landing summarize the step [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-644]** Make review landing tested text high-level [task-review]
  **Verify:** node --test test/commands.test.js
- **[CLI-643]** Stop review landing from listing proof prose as commands [task-review]
  **Verify:** node --test test/commands.test.js
- **[CLI-642]** Stop review proof prose becoming fake verifier commands [task-review]
  **Verify:** node --test test/commands.test.js
- **[CLI-641]** Guard recruiting shortcut fallback scope [computer]
  **Verify:** node --test test/computer-create.test.js
- **[CLI-640]** Fix recruiting shortcut typed workspace resolution [computer]
  **Verify:** node --test test/computer-create.test.js
- **[CLI-639]** Align release tests with current publish gate [tests]
  **Verify:** node --test test/repo-shape.test.js test/publish-release.test.js
- **[CLI-638]** Fix context-gatherer duplicate import test failure [tests]
  **Verify:** node --test test/context-gatherer.test.js
- **[CLI-637]** Refresh ax self-contained script assertion [ax]
  **Verify:** node --test test/ax.test.js
- **[CLI-636]** Align review-output regressions with approval console [review]
  **Verify:** node --test test/review-lane-auto-review.test.js test/task-receipt-evidence.test.js
- **[CLI-635]** Keep quoted test-name verifier commands in review proof [review]
  **Verify:** node --test test/commands.test.js
- **[CLI-634]** Fix mission XP native-goal ack regression [mission]
  **Verify:** node --test test/mission-xp.test.js
- **[CLI-633]** Make command XP copy approval-facing [self-improve]
  **Verify:** git diff --check
- **[CLI-632]** Make business handoff XP gate approval-facing [self-improve]
  **Verify:** git diff --check
- **[CLI-631]** Limit default review approval console [self-improve]
  **Verify:** git diff --check
- **[CLI-630]** Replace ready-to-land review labels [self-improve]
  **Verify:** git diff --check
- **[CLI-629]** Make review reason line product-facing [self-improve]
  **Verify:** git diff --check
- **[CLI-628]** Make review summary human-facing [cli]
  **Verify:** git diff --check
- **[CLI-627]** Make review decision line human-facing [cli]
  **Verify:** git diff --check
- **[CLI-626]** Make review saved line product-facing [cli]
  **Verify:** git diff --check
- **[CLI-625]** Make default landing result completed [cli]
  **Verify:** git diff --check
- **[CLI-624]** Summarize prose-only landing proof checks [cli]
  **Verify:** git diff --check
- **[CLI-623]** Show omitted landing proof checks [cli]
  **Verify:** git diff --check
- **[CLI-622]** Make review landing checked proof-specific [cli]
  **Verify:** git diff --check
- **[CLI-621]** Trim prose after proof commands [cli]
  **Verify:** git diff --check
- **[CLI-620]** Trim passed-with proof command tails [cli]
  **Verify:** git diff --check
- **[CLI-619]** Number multi-command proof lists [cli]
  **Verify:** git diff --check
- **[CLI-618]** Document task reviews --all [cli]
  **Verify:** git diff --check
- **[CLI-617]** Trim verbose pass-count explanations [cli]
  **Verify:** git diff --check
- **[CLI-616]** Trim proof pass-count tails [cli]
  **Verify:** git diff --check
- **[CLI-615]** Render proof commands without pipe ambiguity [task]
  **Verify:** git diff --check
- **[CLI-614]** Heal stale MAP refs surfaced by clean [clean]
  **Verify:** git diff --check
- **[CLI-613]** Respect quoted pipes in proof commands [task]
  **Verify:** git diff --check
- **[CLI-612]** Show MAP refs clean would heal [clean]
  **Verify:** git diff --check
- **[CLI-611]** Stop caller-session mission run from sleeping after tick [mission-run]
  **Verify:** git diff --check
- **[CLI-610]** Ignore quoted product examples in review command extraction [review-chat]
  **Verify:** git diff --check
- **[CLI-609]** Clean redundant next wording in mission report text [mission-report]
  **Verify:** git diff --check
- **[CLI-608]** Keep mission report timeline titles one-line [mission-report]
  **Verify:** git diff --check
- **[CLI-607]** Keep mission report goal labels clean when summaries already name a goal [mission-report]
  **Verify:** git diff --check
- **[CLI-606]** Keep review proof commands from swallowing prose [review-chat]
  **Verify:** git diff --check
- **[CLI-605]** Keep always-on mission next action running after verifier pass [mission-goal]
  **Verify:** git diff --check
- **[CLI-604]** Expose effective mission verifier in JSON [mission-status]
  **Verify:** git diff --check
- **[CLI-603]** Give overnight self-improve missions a default verifier [mission-doctor]
  **Verify:** git diff --check
- **[CLI-602]** Keep task review JSON receipts concise [task-review]
  **Verify:** git diff --check
- **[CLI-601]** Stop mission report duplicate Goal prefixes [mission-report]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-600]** Refresh team member standard feature docs [members]
  **Verify:** git diff --check
- **[CLI-599]** Refresh customer skill zone feature docs [skills]
  **Verify:** git diff --check
- **[CLI-598]** Refresh CLI UX validation from current help [cli]
  **Verify:** git diff --check
- **[CLI-597]** Refresh wiki feature validation docs [wiki]
  **Verify:** git diff --check
- **[CLI-596]** Refresh workspace initialization wiki contract [wiki]
  **Verify:** git diff --check
- **[CLI-595]** Batch refresh README-backed wiki pages [wiki]
  **Verify:** git diff --check
- **[CLI-594]** Refresh horizon type wiki from autopilot [wiki]
  **Verify:** git diff --check
- **[CLI-593]** Refresh agent activation contract from CLAUDE adapter [wiki]
  **Verify:** git diff --check
- **[CLI-592]** Refresh Atris business wiki command surface [wiki]
  **Verify:** git diff --check
- **[CLI-591]** Refresh Atris CLI wiki command surface from README [wiki]
  **Verify:** git diff --check
- **[CLI-590]** Repair recursive self-improvement wiki contract [wiki]
  **Verify:** git diff --check
- **[CLI-589]** Add source metadata to glass interface wiki page [wiki]
  **Verify:** git diff --check
- **[CLI-588]** Stop Atris Labs protocol brief from self-staling [wiki]
  **Verify:** git diff --check
- **[CLI-587]** Heal latest MAP ref drift from clean [map]
  **Verify:** git diff --check
- **[CLI-586]** Hide empty handoff ticks from mission report timeline [mission-report]
  **Verify:** git diff --check
- **[CLI-585]** Make mission run --json machine-readable [mission-run]
  **Verify:** git diff --check
- **[CLI-584]** Stop task render resurrecting stale backlog [task-render]
  **Verify:** git diff --check
- **[CLI-583]** Heal MAP refs reported by clean [map]
  **Verify:** git diff --check
- **[CLI-582]** Make clean --json machine-readable [clean]
  **Verify:** git diff --check
- **[CLI-581]** Use task title as review verification objective [task-review]
  **Verify:** git diff --check
- **[CLI-580]** Show mission report timeline from run receipts [mission-report]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-579]** Let mission tick write ad hoc verifier receipts [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-578]** Stop repeating certified endgame seed while human accept waits [task-next]
  **Verify:** node --test test/commands.test.js
- **[CLI-577]** Audit and close next runner-agnostic heartbeat gap [runner]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-576]** Suppress stale compiled endgame from loop next moves [loop]
  **Verify:** node --test test/moves.test.js test/loop-front.test.js
- **[CLI-575]** Keep always-on mission tick next action runnable [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-574]** Reconcile drifted brainstorm validate refs [wiki]
  **Verify:** node --test test/commands.test.js --test-name-pattern=brainstorm
- **[CLI-572]** Infer overnight settings from mission run objective [mission]
  **Verify:** node --test test/mission-status.test.js test/pulse.test.js test/loop-front.test.js
- **[CLI-571]** Support 6-hour overnight heartbeat expiry [pulse]
  **Verify:** node --test test/pulse.test.js test/loop-front.test.js
- **[CLI-570]** Mission XP: work overnight and see where we can self improve. goal after goal nonstop 6 hours [agent-xp]
  **Verify:** node --test test/pulse.test.js
- **[CLI-569]** Make Mission Room chat-first before mission execution [mission-room]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-568]** Mission XP: Decide and start the next useful mission after: Ship Cash Proof Mission Room [agent-xp]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-567]** Mission XP: Ship Cash Proof Mission Room [agent-xp]
  **Verify:** node scripts/verify-ship-cash-proof-mission-room.js
- **[CLI-566]** Mission XP: Make Mission Room name the real business move instead of generic approval-room labels [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-565]** Mission XP: make Mission Room verification print the landing version instead of engineering VERIFIED output [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-564]** Mission XP: dogfood Mission Room so every run produces a concise human timeline of goals, decisions, builds, and proof [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-563]** Mission XP: find a way to constantly prune and compress atris runs so they stay concise [agent-xp]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-562]** Mission XP: build mission completion artifacts as chronological timeline lists [agent-xp]
  **Verify:** node scripts/verify-mission-artifact-timeline.js
- **[CLI-561]** Mission XP: think through beautiful human-readable HTML and Markdown mission run receipts with block support for Project Obelisk and Atris runs [agent-xp]
  **Verify:** node scripts/verify-human-readable-mission-artifact.js
- **[CLI-560]** Mission XP: make Mission Room preview task-first with editable member routing and landing result [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-559]** Mission XP: add member logs context and proactive next mission suggestions to Mission Room [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-558]** Mission XP: add thinking.md operator memory to Mission Room CLI and dogfood it [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-557]** Mission XP: make Mission Room ask sharp clarifiers and produce an approval packet before starting the goal chain [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-556]** Mission XP: ship the first Chaos -> Mission Room activation slice in atris-cli: messy input becomes a mission card, first proof step, verifier, and shareable receipt path [agent-xp]
  **Verify:** node scripts/verify-mission-room.js
- **[CLI-555]** Mission XP: discover the Atris product wedge tonight: test 5 candidate outcomes for mission magic, score relief/proof/shareability, and pick the first product-led growth mission [agent-xp]
  **Verify:** node scripts/verify-mission-product-wedge.js
- **[CLI-554]** Mission XP: tight runway cash sprint: turn the Acme PO and near-term Atris demand into cash fast, starting tomorrow, while the mission loop ships proof-backed product [agent-xp]
  **Verify:** node scripts/verify-runway-cash-sprint.js
- **[CLI-553]** Mission XP: Audit and close next runner-agnostic heartbeat gap [agent-xp]
  **Verify:** node --test test/autopilot-runner-model.test.js test/runner-command.test.js
- **[CLI-552]** Mission XP: Refresh Atris brain after AI-memory-moat and review-lane mission chain, then stop at human gate [agent-xp]
  **Verify:** node --test test/commands.test.js --test-name-pattern=brain
- **[CLI-551]** Mission XP: Decide and start the next useful mission after: Review proof-ready CLI-547 and CLI-548, certify only if evidence holds, and leave human accept untouched [agent-xp]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-550]** Mission XP: Review proof-ready CLI-547 and CLI-548, certify only if evidence holds, and leave human accept untouched [agent-xp]
  **Verify:** node scripts/verify-review-lane-receipt.js
- **[CLI-549]** Mission XP: Decide and start the next useful mission after: take all these AI-memory-moat insights, validate we captured them all, and keep setting bounded goals while Keshav lifts [agent-xp]
  **Verify:** node --test test/commands.test.js --test-name-pattern=review-lane
- **[CLI-548]** Mission XP: Overnight dogfood: exercise every atris surface, ship bounded proof each tick [agent-xp]
  **Verify:** test -f atris/runs/dogfood-feature-loop-2026-06-28.jsonl && node --test test/commands.test.js --test-name-pattern=launchpad
- **[CLI-544]** Mission XP: tiny proof-only mission: prove mission run can start, tick, and complete without product file edits [agent-xp]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-530]** Mission XP: Make ax cloud-first a durable team standard [agent-xp]
  **Verify:** node scripts/verify-ax-cloud-standard.js
- **[CLI-528]** Mission XP: Fix ax fast auto-routing so prose writing stays cloud and local is only for workspace side effects [agent-xp]
  **Verify:** node --test test/ax.test.js
- **[CLI-393]** Clean up any stale wiki pages from session changes [maintenance]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-384]** Document atris run diff in README, CLAUDE.md, wiki, MAP.md [docs]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-381]** Document atris run export in README, CLAUDE.md, wiki, MAP.md [docs]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-378]** Document atris run stats in README, CLAUDE.md, wiki, MAP.md [docs]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-376]** Add glass logging to atris autopilot tick phases [code]
  **Verify:** node --test test/autopilot-glass-logging.test.js
- **[CLI-374]** Update MAP.md with searchRunLogs function [maintenance]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-368]** Update MAP.md with pruneRunLogs function [maintenance]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-361]** Add run logs to CLAUDE.md and AGENTS.md documentation [docs]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-360]** Update MAP.md with new run.js glass log functions and subcommand [maintenance]
  **Verify:** node --test test/run-glass-logs.test.js
- **[CLI-357]** Add glass interface principle to wiki index and STATUS [wiki]
  **Verify:** node --test test/run-glass-logs.test.js

## Blocked

- **[CLI-501]** Design 24/7 functional team member factory [team-members]
- **[CLI-500]** Replace generic codex-executor ownership with functional team roles [team-roles]
- **[CLI-407]** Generate Atris Labs recruiting sync conflict packet [recruiting-sync]
- **[CLI-331]** Store YouTube analysis for Ec7VbXHg0uI [wiki]
- **[CLI-325]** Auto-improver: Next tick will stop until a human looks at the error. [auto-improver]
- **[CLI-223]** skill audit: no-xml-tags flags placeholders inside code blocks (9 skills false-FAIL) [cli-ux]
- **[CLI-222]** Revalidate 8 stale feature packs: heal drifted line refs, rerun rubric checks, bump last_compiled [wiki]
- **[CLI-221]** Recompile stale wiki pages that feed agent boot (systems/atris-cli, overview brief, concepts) [wiki]
- **[CLI-220]** Heal workspace drift: 82 stale MAP.md refs + archive 33 old journals via atris clean [maintenance]
- **[CLI-216]** Ship launch post: post linkedin-post.md, capture URL in journal, delete the file
- **[CLI-200]** Auto-improver: Recurring log pattern: Next tick will stop until a human looks at the error. [auto-improver]
- **[CLI-162]** Refresh control packets after b20be master advance [review]

(6 older blocked tasks archived in `atris task list --status failed` and `atris task events`.)

## Completed

- **[CLI-547]** Mission XP: take all these AI-memory-moat insights, validate we captured them all, and keep setting bounded goals while Keshav lifts [agent-xp]
  **Verify:** node scripts/verify-ai-memory-moat.js
- **[CLI-546]** Fix dogfood verifier failures after Valhalla changes [dogfood]
  **Verify:** node --test test/commands.test.js --test-name-pattern=launchpad
- **[CLI-545]** Mission XP: Watch chat/log/task signals, infer what the operator wants, and run one bounded proof-backed action per tick [agent-xp]
  **Verify:** node scripts/verify-chat-scan.js
- **[CLI-543]** Valhalla fix: route atris loop to the loop front door [loop]
  **Verify:** node --test test/loop-front.test.js
- **[CLI-542]** Valhalla gate: mission doctor flags slop missions [mission]
  **Verify:** node scripts/verify-mission-doctor.js
- **[CLI-541]** Valhalla gate: remote-computer mission parity acceptance test [mission]
  **Verify:** node scripts/verify-valhalla.js
- **[CLI-540]** Valhalla gate: ranked next-move source for atris loop [loop]
  **Verify:** node scripts/verify-valhalla-roadmap.js
- **[CLI-539]** Valhalla gate: visible review acceptance receipt [task-review]
  **Verify:** node scripts/verify-valhalla-roadmap.js

(269 older completed tasks archived in `atris task list --status done` and `atris task events`.)
