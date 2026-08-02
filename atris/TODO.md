# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-1207]** pack readers enforce compressed size, file count, and declared unpacked limits before inflation so local, URL, registry, pull, and update inputs cannot become zip bombs [security]
- **[CLI-1198]** the member wake test passes alone but fails when the full suite runs before it, so a red suite can point at the wrong culprit; find the state it inherits (likely env or homedir bleed) and isolate it [health]
- **[CLI-1197]** A stranded commit would silently delete the entire test coverage for the mission-lane diff guard, leaving the guard implemented but unprotected against future breakage. Found 2026-07-26 in worktree .agent-worktrees/atris-cli/architect-mission-protected-lane-gate-20260726-083719, commit ea7084bd 'mission ticks hold before firing when the mission sits in a protected lane'. The ADDITION is good and worth keeping: a pre-tick hold that pauses a mission sitting in a protected lane before any tick fires, releasing only on explicit human ack — genuine defence in depth, since stopping before work starts beats stopping at commit time. The PROBLEM is what it removes. It deletes 262 lines from test/mission-protected-lane.test.js, taking out all eight diff-inspection tests: a clean diff reaches the landing callback, a CSP diff pauses and names the surface, an auth-header diff pauses from changed CONTENT on a neutral path, an unreadable diff fails closed, a denied tag pauses when text looks neutral, the git-wrapper leaves a protected change staged, a protected tick writes the matched surface to its receipt, and the Atris2 relay keeps the wrapper first on PATH. It replaces them with four tests that only check lane tags and objective text. matchProtectedMissionDiff appears zero times in the resulting test file, while remaining present three times in lib and wired four times in commands/mission.js — so the implementation survives with no coverage. That is precisely the hole CLI-1189 exists to close: a mission GENERATES its own work, so its objective can be innocuous while its tick writes a CSP change. That is not hypothetical — mission 6 tick 1 self-landed force-dynamic on a public page under the objective 'next bounded improvement'. Objective-text routing cannot catch that; only diff inspection can. Done: the pre-tick hold lands AND every deleted diff-inspection test is restored, so both gates are covered. Check: node --test test/mission-protected-lane.test.js [security]
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

- **[CLI-1194]** Decision rows look identical to work rows, so an autonomous lane will happily answer a question that was addressed to a human. The task system has no way to say 'this needs a judgement call, not an implementation', lane tags describe DOMAIN (billing, security, deploy) not whether autonomy is appropriate, so a policy question tagged web-quality is fully claimable and the fleet will staff it and pick a branch. Twice in one night on atrisos-web: WEB-453 (mount the notification bell into the dashboard, or delete it and its live backend) and WEB-458 (raise the failing total-bundle budget, or replace the metric). Both were written FOR Keshav; both sat claimable; an engine taking either would have silently decided product or guard policy. The only defence available was manually claiming each row to a human, because the fleet skips claimed rows, a workaround that depends on someone noticing. Done: a row can be marked as needing human judgement independently of its lane tag, autonomous lanes skip such rows the way they skip denied lanes, and the marker is visible in atris task list so it is not invisible to whoever files next. Check: node --test test/task-*.test.js [web-quality]
  **Claimed by:** fleet-codex
- **[CLI-1189]** The self-driving mission lane can land security-scoped changes with no human pre-land review, while every neighbouring lane blocks them, so the one loop that runs unattended overnight is the one lane with no guard. Verified 2026-07-25: DENIED_TAGS and the protected-lane text check exist in lib/fleet.js, lib/auto-accept-certified.js, commands/task.js and commands/brief.js, but commands/mission.js and lib/mission-{runtime-loop,room,root,artifact}.js reference none of them. Hit live: mission 6 tick 1 self-landed a CSP change to atrisos-web master (force-dynamic on a public page so it ships the nonce, commit 025099eb). That diff is correct and audit:static-routes passes, the problem is that nothing would have stopped a wrong one. This is the same hole that produced the WEB-448 incident, in a different lane. Done: a mission tick whose diff touches a protected lane (auth, session, CSP, billing, deploy) pauses for human review instead of landing, using the same text-plus-tag routing the task lane already has. Check: node --test test/mission*.test.js [security]
  **Claimed by:** architect
- **[CLI-1186]** Fleet receipt truncates the head of a ship failure, hiding the cause. lib/fleet.js:2039 and :2365 slice(-300)/slice(-500) keep only the stack TAIL, so 'MODULE_NOT_FOUND: cannot find X' is cut and the operator sees five frames of node internals. Keep the first ~400 chars too (head+tail), since the error line leads. Done: a ship failure receipt names the failing module/command. Check: node --test test/fleet*.test.js [web-quality]
  **Claimed by:** fleet-cursor
- **[CLI-1182]** atris wish stream got swallowed as a new wish named stream, so any status check pollutes the wish list; reserved subcommands must never be treated as wish text [wish]
  **Claimed by:** fleet-codex
- **[CLI-1181]** the wish intake echoes a truncated title and asks the same three generic options for every wish, so the first thing an owner hears is mush; drill questions must come from the wish's own words [wish]
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

- **[CLI-1206]** pack install validates the whole archive before writing: missing manifests, duplicate paths, and symlink escapes fail closed with zero partial files [security]
  **Verify:** node --test test/pack-craft.test.js test/pack-run.test.js test/pack-safety.test.js test/pack-share.test.js test/pack.test.js test/console-packet-shape.test.js
- **[CLI-1196]** a gift-card purchase command landed on master overnight with no task and no review; it can open checkout and settle payments, so it was reverted on sight per the money-lane rule. decide: bless it behind a human gate and re-land from the revert, or keep it out [money]
- **[CLI-1180]** one day someone says: atris, make me a million dollars, and it actually works. it creates the computer, the folder, the context. it sets up the storyline and the missions. it figures things out with the best intelligence and unblocks itself. it never writes generic output, no jargon ever reaches the human. the owner is at peace, out dancing in ibiza, and the businesses are just running. [wish]
- **[CLI-1148]** Mission XP: Proof Build Validate Mission Room with architect [agent-xp]
- **[CLI-1146]** Mission XP: Build Numbers Pack Mission Room with mission-lead [agent-xp]

## Blocked

(Empty)

## Completed

- **[CLI-1205]** local pack installs show the real source [pack]
  **Verify:** node --test test/pack.test.js test/pack-run.test.js test/console-packet-shape.test.js
- **[CLI-1204]** private packs stay private when repackaged [pack]
  **Verify:** node --test test/pack.test.js
- **[CLI-1203]** pack run loads shipped skills into Claude [pack]
  **Verify:** node --test test/pack-run.test.js test/console-packet-shape.test.js
- **[CLI-1202]** the team page survives weekly model upgrades: engines list their current models from one editable file, so swapping a model never touches code
  **Verify:** node --test test/engine.test.js
- **[CLI-1201]** wiki bloat warning shows up on its own in tidy and boot instead of waiting to be asked
  **Verify:** node --test test/wiki-metabolism-warning.test.js
- **[CLI-1200]** readers see 2-3 plain ideas max on every cli surface: teach the voice gate shape rules so tired readers understand at a glance
  **Verify:** node --test test/voice-gate.test.js
- **[CLI-1199]** wiki pruning metabolism: fact-count-triggered consolidation in upkeep (qm steal #2)
  **Verify:** node --test test/wiki-metabolism.test.js
- **[CLI-1195]** Engines finish work, commit it to a worktree, and it silently never lands, nine commits are stranded right now and the oldest is five days old, so the fleet looks productive while its output evaporates. Swept 2026-07-26 across atris-cli and atrisos-web worktrees, listing commits ahead of origin/master: dbf14daf cli status summaries, e6b83dd6 one-lap racing mission drivers, 5c87421b fleet receipt head (CLI-1186), ae661929 honest empty mission reports (2026-07-21), 7ddb00cf name the worker start command (2026-07-21), 89da102f GM overview honest and action-led, fe74de46 social connections across profiles, 1824d2f3 paywall lazy-load (WEB-455), 560254a1 mission tick summaries. Two were rescued by hand tonight (WEB-455 recovered from a SIGTERM-killed engine, CLI-1186 cherry-picked and landed as ec302673) and both were found only because someone went looking. Four of the nine cannot even rebase, their worktrees carry unstaged regenerated adapter files (AGENTS.md, CLAUDE.md, GEMINI.md, atris/TODO.md), which is CLI-1190. Nothing reports this: no receipt, no alarm, no digest line. Done: a worktree holding commits ahead of origin/master is surfaced, autoland reports stranded worktrees with their commit subjects and age, and reaping refuses to delete a worktree with unlanded commits unless explicitly forced. Check: node --test test/fleet*.test.js [web-quality]
  **Verify:** node --test test/fleet.test.js test/fleet-stranded-worktrees.test.js

(39 older completed tasks archived in `atris task list --status done` and `atris task events`.)
