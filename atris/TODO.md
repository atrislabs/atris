# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-1280]** an unpaid buyer hitting install gets told the price and how to buy instead of a confusing empty download
- **[CLI-1279]** the release gate stops relying on memory: tag publishes run the full suite again or the tagger gets a hard checklist it enforces
- **[CLI-1259]** Make a Fable handoff either start work or clearly say it failed [engines]
- **[CLI-1251]** Turn the daily log into a simple product-work handoff so the right team member can act and validation closes the loop [product-operations]
- **[CLI-1250]** Make Atris.md the single voice rule so every agent gives clear next decisions
- **[CLI-1236]** every command reads flags consistently from one maintained parser [cli]
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

- **[CLI-1285]** the build meter bills only real job time and one worker serves every repo, so customer bills stay honest and setup stays one command
  **Claimed by:** codex-ci-slice3
  **Verify:** node --test test/ci.test.js
- **[CLI-1267]** Quiet task board: make the cross-project task list show only work that needs attention now, so it can replace a noisy Linear board [task-board]
  **Claimed by:** task-planner
  **Verify:** node --test test/task*.test.js
- **[CLI-1265]** Local workforce presence command: show which local engines and team members are working, waiting, done, or stale from real process and final-result state, then clear finished runs [cli]
  **Claimed by:** runtime-engineer
  **Verify:** npm test -- --runInBand
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

- **[CLI-1284]** build minutes get counted and shown per repo, so the fifty-a-month credit deal has real usage numbers to bill against
  **Verify:** node --test test/ci.test.js
- **[CLI-1283]** atris ci slice 1: local ephemeral github actions runner (jit config, one word runs-on swap)
  **Verify:** node --test test/ci.test.js
- **[CLI-1281]** atris pack purchases shows the buyer their purchases instead of calling an address that does not exist
- **[CLI-1278]** the engine scoreboard feeds itself: recent unchecked answers get graded automatically on the hourly tick, capped and cheap
- **[CLI-1277]** publishers stop hand-computing pack contract fields: one command seals type, entrypoint, permissions, provenance, and content hashes
  **Verify:** node --test /Users/keshavrao/arena/atris-cli-worktrees/cli-1277-pack-seal/test/pack.test.js
- **[CLI-1276]** an hvac shop owner can install a ready pack and run invoice chasing, renewals, reviews, and call triage with honest ai workers
- **[CLI-1275]** scout gets enough time to finish: measure real pack build times and set the timeout from data
- **[CLI-1274]** jobs that die and leave a stale running claim get found on the hourly sweep and marked dead honestly
- **[CLI-1273]** expensive builders start with a verified map of exactly where to work instead of burning their first minutes searching
- **[CLI-1272]** the taste gate finally guards the door: work that breaks a written correction is refused at landing with the reason named
- **[CLI-1271]** one front door per engine: name plus model plus task or question runs the whole blessed pattern with atris coaching baked in
- **[CLI-1270]** finished work gets checked by a cheap referee whose verdicts pile up into an engine scoreboard
- **[CLI-1269]** a worker that dies silently or lies about landing now leaves an honest failure receipt instead of a blank
- **[CLI-1268]** Earned team pulse: give local team views one brief, specific encouragement based on real work, without adding noise to customer output [cli]
  **Verify:** node --test test/team-roster.test.js test/team-presence.test.js test/now.test.js
- **[CLI-1266]** Engine completion updates: immediately surface each local engine's final answer, timeout, or failure so finished work never waits unseen [cli]
  **Verify:** Focused lifecycle regression tests and a live multi-engine run with timestamped terminal updates.
- **[CLI-1264]** pin grok 4.6 across engine registry, runner profile, and engine guide
- **[CLI-1258]** Show live engine progress so an operator can see what a background job is doing before it finishes [engines]
- **[CLI-1256]** Verify that Grok can return one clear answer through the tracked dispatch path
- **[CLI-1245]** Mission XP: Proof Keep Improving Mission Room with validator [agent-xp]
- **[CLI-1242]** split the task board api into named route handlers [cli]
- **[CLI-1237]** CLI users get consistent flag behavior because every command shares one parser [cli]
  **Verify:** git -C /Users/keshavrao/arena/atris-cli-worktrees/codex-arg-parser2 diff --cached --check
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

- **[CLI-1282]** every atris install teaches its agent the house voice at the moment of writing: a natural card beside each message, in every coding tool
- **[CLI-1263]** cursor answers in six seconds instead of sixty-seven when asked from the home folder, so quick cursor questions become actually quick
  **Verify:** node --test test/engine-ask.test.js
- **[CLI-1262]** an ask can name the exact model per engine, so one question can race grok against kimi through cursor or haiku against opus without config changes
  **Verify:** node --test test/engine-ask.test.js
- **[CLI-1261]** two one-lap tests fail on clean master, so the suite blames innocent branches; the fake codex leg dies and restaffs to cursor since the watchdog wrap landed
  **Verify:** node --test test/fleet-codex-watchdog.test.js
- **[CLI-1260]** the team dashboard counts the operator as an awake agent; show the operator separately and count only real team members
  **Verify:** node --test test/team-presence.test.js
- **[CLI-1257]** Build a parallel read-only engine ask lane so one question can reach many models without blocking product work [engines]
  **Verify:** node --test test/engine-ask.test.js
- **[CLI-1254]** Document the safe engine dispatch rule so future voice chats use available subscriptions correctly
  **Verify:** test -s atris.md
- **[CLI-1252]** Fix the Grok startup connection failure so short research checks return a final answer
  **Verify:** node --test test/engine-ask.test.js

(82 older completed tasks archived in `atris task list --status done` and `atris task events`.)
