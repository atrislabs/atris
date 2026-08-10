# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-979]** csrf gate should exempt cookie-less bearer-token api calls so every cli lane works without origin workarounds; protected lane, orb reviews pre-merge
- **[CLI-958]** yo can you make me the best to do list ever [wish]
- **[CLI-957]** make me the best landing page ever [wish]
- **[CLI-952]** orb-slate 15: every lap launches itself - shipped work auto-produces card/reel/post
- **[CLI-951]** orb-slate 14: overnight autoresearch as a customer dial - expose pulse prune/strengthen loop
- **[CLI-950]** orb-slate 13: wish-to-company - pooled capital into a wish, founders as approval queue
- **[CLI-949]** orb-slate 12: self-staffing - shifts + XP ladder for humans and AI (AgentGrads checkout wiring)
- **[CLI-948]** orb-slate 11: the FDE exam - hackerrank for FDEs scored on real atris laps
- **[CLI-947]** orb-slate 10: receipts as compliance - receipt ledger as SOC2-grade evidence
- **[CLI-946]** orb-slate 9: loop packs sold as laps - package DoorDash BQR + Pallet recruiting for customer N+1
- **[CLI-944]** orb-slate 7: second-brain check-ins - system schedules interviews to keep memory current
- **[CLI-943]** orb-slate 6: day loop cloned per operator - morning card + evening close for Justin next
- **[CLI-942]** orb-slate 5: plain-english approval queue - waiting-on-you as one sentence each, approvable from phone/SMS
- **[CLI-941]** orb-slate 4: watch the forward pass - live web view of the neural-net lap in atrisos-web
- **[CLI-940]** orb-slate 3: weights that update - receipts auto-tune engine/prompt routing nightly
- **[CLI-935]** rendering it in atrisos-web [wish]
- **[CLI-934]** this is about serving that projection through the backend [wish]
- **[CLI-933]** on the web i can see which members are awake and doing work, simply. i can see their actions and the loops that are running. the same view comes to our ios app later, desktop someday - for now the cloud versions. the data already exists in atris stream, task status --json, mission status, and the member alive loops [wish]
- **[CLI-912]** AgentXP Mode first rep: complete one proof-backed useful mission [agent-xp]

## In Progress

- **[CLI-1231]** Pablo sees one honest pack card before expert diagnostics: what it is, where it lives, whether it is ready, why, and one next action. Keep inspect and doctor as drill-down. Done: atris pack show covers ready, revise, and reject; performs no network, execution, or mutation; stays within eight content lines. Check: node --test test/pack-show.test.js test/pack-safety.test.js [pack]
  **Claimed by:** architect
- **[CLI-1209]** Mission XP: turn our hardest standing lessons into automatic [agent-xp]
  **Claimed by:** builder
  **Verify:** npm test
- **[CLI-1194]** Decision rows look identical to work rows, so an autonomous lane will happily answer a question that was addressed to a human. The task system has no way to say 'this needs a judgement call, not an implementation', lane tags describe DOMAIN (billing, security, deploy) not whether autonomy is appropriate, so a policy question tagged web-quality is fully claimable and the fleet will staff it and pick a branch. Twice in one night on atrisos-web: WEB-453 (mount the notification bell into the dashboard, or delete it and its live backend) and WEB-458 (raise the failing total-bundle budget, or replace the metric). Both were written FOR Keshav; both sat claimable; an engine taking either would have silently decided product or guard policy. The only defence available was manually claiming each row to a human, because the fleet skips claimed rows, a workaround that depends on someone noticing. Done: a row can be marked as needing human judgement independently of its lane tag, autonomous lanes skip such rows the way they skip denied lanes, and the marker is visible in atris task list so it is not invisible to whoever files next. Check: node --test test/task-*.test.js [web-quality]
  **Claimed by:** fleet-codex
- **[CLI-1189]** The self-driving mission lane can land security-scoped changes with no human pre-land review, while every neighbouring lane blocks them, so the one loop that runs unattended overnight is the one lane with no guard. Verified 2026-07-25: DENIED_TAGS and the protected-lane text check exist in lib/fleet.js, lib/auto-accept-certified.js, commands/task.js and commands/brief.js, but commands/mission.js and lib/mission-{runtime-loop,room,root,artifact}.js reference none of them. Hit live: mission 6 tick 1 self-landed a CSP change to atrisos-web master (force-dynamic on a public page so it ships the nonce, commit 025099eb). That diff is correct and audit:static-routes passes, the problem is that nothing would have stopped a wrong one. This is the same hole that produced the WEB-448 incident, in a different lane. Done: a mission tick whose diff touches a protected lane (auth, session, CSP, billing, deploy) pauses for human review instead of landing, using the same text-plus-tag routing the task lane already has. Check: node --test test/mission*.test.js [security]
  **Claimed by:** architect
- **[CLI-1186]** Fleet receipt truncates the head of a ship failure, hiding the cause. lib/fleet.js:2039 and :2365 slice(-300)/slice(-500) keep only the stack TAIL, so 'MODULE_NOT_FOUND: cannot find X' is cut and the operator sees five frames of node internals. Keep the first ~400 chars too (head+tail), since the error line leads. Done: a ship failure receipt names the failing module/command. Check: node --test test/fleet*.test.js [web-quality]
  **Claimed by:** fleet-cursor
- **[CLI-1182]** atris wish stream got swallowed as a new wish named stream, so any status check pollutes the wish list; reserved subcommands must never be treated as wish text [wish]
  **Claimed by:** fleet-codex
- **[CLI-1168]** it should say no worker has produced a receipt yet and name the command that starts one [wish]
  **Claimed by:** mission-lead
- **[CLI-1165]** a wish that says delegated must have a live worker: dispatch verifies the engine actually started, and mission report never says working when there is no receipt and no driver
  **Claimed by:** fleet-claude
- **[CLI-1162]** Mission XP: Bounded Test Every Mission Room with improver [agent-xp]
  **Claimed by:** improver
  **Verify:** node --test test/voice-gate.test.js test/mission-status.test.js
- **[CLI-1156]** get a mission can carry a real dollar budget and moving again: max ticks reached [mission-blocker]
  **Claimed by:** fleet-codex
- **[CLI-1149]** Mission XP: Casa Naranja week one [agent-xp]
  **Claimed by:** researcher
  **Verify:** test -s atris/team/researcher/casa-naranja/week-one.md
- **[CLI-1147]** a mission can carry a real dollar budget and atris mission report shows spent, what got done, and remaining in plain words, like: budget 100, spent 5, remaining 95, here is what you got [wish]
  **Claimed by:** fleet-claude
- **[CLI-1130]** get the first outside customer to pay for atris [mission-blocker]
  **Claimed by:** fleet-codex
- **[CLI-1128]** run the four hour working session with mission-lead and show what it produced [agent-xp]
  **Claimed by:** mission-lead
  **Verify:** git diff --check
- **[CLI-1127]** build the numbers pack from real records only, nothing estimated [mission-blocker]
  **Claimed by:** fleet-codex
- **[CLI-1126]** keep every screen a person reads short and current [mission-blocker]
  **Claimed by:** fleet-codex
- **[CLI-1125]** combine tools we already have into new product ideas [mission-blocker]
  **Claimed by:** fleet-codex
- **[CLI-1124]** run the two hour status session with mission-lead and show what it produced [agent-xp]
  **Claimed by:** mission-lead
  **Verify:** git diff --check
- **[CLI-1113]** Mission XP: Decide and start the next useful mission after: Repair the blocked operator-report mission by reproducing the live-update receipt failure, shipping one bounded verified fix, and continuing only after proof. [agent-xp]
  **Claimed by:** linguist
- **[CLI-984]** test/commands.test.js:645 worktree-target test fails on master (expects /feature work/, gets '54d8fe6 init'); pre-existing before PR 342, confirmed on merge parents 91cbcb3 and 52595ec on 2026-07-09
  **Claimed by:** keshavrao
- **[CLI-966]** S6 activate boot line: build slice S6 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/activate-boot.test.js
  **Claimed by:** fleet-claude
- **[CLI-964]** S4 scoped push: build slice S4 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/push-scoped.test.js
  **Claimed by:** fleet-cursor
- **[CLI-963]** S3 cloud orphans: build slice S3 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/cloud-clean.test.js
  **Claimed by:** fleet-devin
- **[CLI-962]** S2 sync --review conflict handler: build slice S2 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/sync-review.test.js
  **Claimed by:** fleet-grok
- **[CLI-931]** justin is connected as an operator - the system should give him ios notifications and a daily report. it should know what he's working on and be his coach inside this system. it should help him think about how to architect the system and hold him accountable on who he's reaching out to in the most effective way possible - encoded with smart language, not hardcoded rules. at the end of the day he says wow this system is so good, it's helping me. it has rainmaker and the other apps inside it so he can do his outreach from there - it brings the best out of him [wish]
  **Claimed by:** codex-day-loop
  **Verify:** python3 -m py_compile /Users/keshavrao/arena/atrisos-backend/scripts/day_loop.py
- **[CLI-930]** true two-part wishes split again and clarity stops stumbling on paint times, weekdays, and version numbers, so multi-ask wishes never silently lose their second half
  **Claimed by:** codex-bench-round3
- **[CLI-929]** the wish intake reads 13 more real phrasings correctly: fresh visual idioms, two classifier overreaches, three clarity stumbles, one test idiom, so fuzzy wishes keep landing without questions or wrong turns
  **Claimed by:** codex-bench-round2
- **[CLI-928]** every sentence the cli says to a human reads plain: no em dashes reaching your phone, no raw ids in wish replies, no shouting in the boot banner, 19 judged rewrites land
  **Claimed by:** codex-cli-voice
- **[CLI-927]** wish intake understands fuzzy operator language: splitter, frontend detection, clarity questions, and verifier guesses stop misreading 38 confirmed real-world phrasings
  **Claimed by:** codex-wish-intake
- **[CLI-924]** atris improve front door: turn metabolism on and print vitals
  **Claimed by:** codex-improve-door
- **[CLI-923]** pulse: per-repo state home so installs stop clobbering each other, plus restore fundraise loop
  **Claimed by:** codex-pulse-slot
- **[CLI-922]** evolution sensors: usage jsonl + reaper and liveness scan adapters
  **Claimed by:** codex-evolution
- **[CLI-921]** wish design brief: frontend wishes inject design skill/policy/theme into mission room and default verify to audit:design
  **Claimed by:** codex-wish-design
- **[CLI-920]** atris close scan: source adapters auto-open and auto-close flags from tasks/missions/watch files
  **Claimed by:** codex-close-scan
- **[CLI-919]** atris close: closure engine v1 (flag ledger + TTL escalation + operator-voice sweep)
  **Claimed by:** codex-close-engine
- **[CLI-911]** member wake: warm human boot output (gm experience) [cli]
  **Claimed by:** devin

## Review

- **[CLI-1243]** clone one Ryo page with a visual keep-or-revert loop [mimic]
  **Verify:** npm --prefix /Users/keshavrao/arena/mimic-ryo run verify
- **[CLI-1242]** split the task board api into named route handlers [cli]
- **[CLI-1237]** CLI users get consistent flag behavior because every command shares one parser [cli]
  **Verify:** git -C /Users/keshavrao/arena/atris-cli-worktrees/codex-arg-parser2 diff --cached --check
- **[CLI-1236]** every command reads flags consistently from one maintained parser [cli]
- **[CLI-1235]** extract shared CLI flag parser helpers [cli]
- **[CLI-1230]** a new workspace gets a starter team of 5 picked automatically, so the owner never faces 35 folders on day one
- **[CLI-1228]** one team, not two: the org chart reads atris/team members and shows which engine each member runs on, so setting up the team once covers both
- **[CLI-1213]** pack users get enforced capability boundaries because declared permissions change runtime tools instead of only appearing in inspect [security]
  **Verify:** git merge-base --is-ancestor ad16aebb63125256f9a2382c39a6cc6b3b95fe75 HEAD && git merge-base --is-ancestor a4c8dab53a332ef2579e0c9e3758d5fab6c73464 HEAD && git merge-base --is-ancestor 031e80ff13c769c71f523492df0d61fd7a94c45d HEAD && node --test test/pack-run.test.js test/pack.test.js
- **[CLI-1212]** pack users can trust declared content hashes because publish install update and inspect verify every claimed digest [security]
  **Verify:** node --test test/pack.test.js test/pack-safety.test.js test/pack-inspect.test.js test/zip.test.js; npm run test:fast; npm test; live valid/falsified/partial/legacy/same-version probes
- **[CLI-1180]** one day someone says: atris, make me a million dollars, and it actually works. it creates the computer, the folder, the context. it sets up the storyline and the missions. it figures things out with the best intelligence and unblocks itself. it never writes generic output, no jargon ever reaches the human. the owner is at peace, out dancing in ibiza, and the businesses are just running. [wish]

## Blocked

- **[CLI-1198]** the member wake test passes alone but fails when the full suite runs before it, so a red suite can point at the wrong culprit; find the state it inherits (likely env or homedir bleed) and isolate it [health]
- **[CLI-1197]** A stranded commit would silently delete the entire test coverage for the mission-lane diff guard, leaving the guard implemented but unprotected against future breakage. Found 2026-07-26 in worktree .agent-worktrees/atris-cli/architect-mission-protected-lane-gate-20260726-083719, commit ea7084bd 'mission ticks hold before firing when the mission sits in a protected lane'. The ADDITION is good and worth keeping: a pre-tick hold that pauses a mission sitting in a protected lane before any tick fires, releasing only on explicit human ack — genuine defence in depth, since stopping before work starts beats stopping at commit time. The PROBLEM is what it removes. It deletes 262 lines from test/mission-protected-lane.test.js, taking out all eight diff-inspection tests: a clean diff reaches the landing callback, a CSP diff pauses and names the surface, an auth-header diff pauses from changed CONTENT on a neutral path, an unreadable diff fails closed, a denied tag pauses when text looks neutral, the git-wrapper leaves a protected change staged, a protected tick writes the matched surface to its receipt, and the Atris2 relay keeps the wrapper first on PATH. It replaces them with four tests that only check lane tags and objective text. matchProtectedMissionDiff appears zero times in the resulting test file, while remaining present three times in lib and wired four times in commands/mission.js — so the implementation survives with no coverage. That is precisely the hole CLI-1189 exists to close: a mission GENERATES its own work, so its objective can be innocuous while its tick writes a CSP change. That is not hypothetical — mission 6 tick 1 self-landed force-dynamic on a public page under the objective 'next bounded improvement'. Objective-text routing cannot catch that; only diff inspection can. Done: the pre-tick hold lands AND every deleted diff-inspection test is restored, so both gates are covered. Check: node --test test/mission-protected-lane.test.js [security]

## Completed

- **[CLI-1241]** drill and help smoke tests spawn the cli with no cwd and litter .atris/state into the repo root; give them temp cwds. found during the wake-flake investigation.
  **Verify:** node --test test/repo-hygiene.test.js test/drill.test.js test/golden-path-help.test.js
- **[CLI-1240]** engine routing still shells out to command -v inside the resolve path (lib/engine-registry.js binInstalled + normalizeEngineEntry); policy must decide, probes belong at execution stage. found while seeding engine tests.
  **Verify:** node --test test/engine-command.test.js test/engine.test.js
- **[CLI-1239]** drill and help smoke tests spawn the cli with no cwd and litter .atris/state into the repo root; give them temp cwds. found during the wake-flake investigation.
  **Verify:** node --test test/repo-hygiene.test.js
- **[CLI-1238]** engine routing still shells out to command -v inside the resolve path (lib/engine-registry.js:39 binInstalled, normalizeEngineEntry:91); policy must decide, probes belong at execution. found while seeding engine tests.
  **Verify:** node --test test/engine-command.test.js
- **[CLI-1234]** engine dispatch injects matching lessons before work starts [engine]
  **Verify:** node --test test/lesson-preflight.test.js
- **[CLI-1233]** Codex keeps moving instead of getting stuck on impossible mission acknowledgements [mission]
  **Verify:** node --test test/mission-status.test.js
- **[CLI-1232]** Repair Ax Fast context-standard verifier so GitHub mutation routing and turn caps match the current runtime [engine]
  **Verify:** node scripts/verify-ax-cloud-standard.js
- **[CLI-1229]** the team stays lean like a real company: a pruning pass flags members who have not landed work in 30 days, using the same budget-and-keep-rules pattern as the wiki
  **Verify:** node --test test/team-prune.test.js test/team-roster.test.js

(69 older completed tasks archived in `atris task list --status done` and `atris task events`.)
