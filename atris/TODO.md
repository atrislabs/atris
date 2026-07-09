# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Backlog

- **[CLI-967]** wish intake interview loops on tokens from prior answers: after grant/answer text containing line numbers (749-760), quoted error words (Refusing), or a trailing-period token (reference.), the interview asks 'which workspace, repo, file, or team member did you mean by X?' repeatedly and never dispatches. repro: wish-2026-07-09-make-cloud-sync-safe-and-simple-sync-a7d24b4b, 3 consecutive loops on 2026-07-09. fix: the interviewer should not mine noun candidates from operator answers already consumed, and should cap the same-question retry at 1 before proceeding with best guess.
- **[CLI-961]** S1 push safety ux: build slice S1 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/push-safety-ux.test.js
- **[CLI-958]** yo can you make me the best to do list ever [wish]
- **[CLI-957]** make me the best landing page ever [wish]
- **[CLI-956]** make me the best todo list ever [wish]
- **[CLI-955]** make me the best landing page ever [wish]
- **[CLI-954]** make me the best todo list ever [wish]
- **[CLI-953]** make me the best landing page ever [wish]
- **[CLI-952]** orb-slate 15: every lap launches itself - shipped work auto-produces card/reel/post
- **[CLI-951]** orb-slate 14: overnight autoresearch as a customer dial - expose pulse prune/strengthen loop
- **[CLI-950]** orb-slate 13: wish-to-company - pooled capital into a wish, founders as approval queue
- **[CLI-949]** orb-slate 12: self-staffing - shifts + XP ladder for humans and AI (AgentGrads checkout wiring)
- **[CLI-948]** orb-slate 11: the FDE exam - hackerrank for FDEs scored on real atris laps
- **[CLI-947]** orb-slate 10: receipts as compliance - receipt ledger as SOC2-grade evidence
- **[CLI-946]** orb-slate 9: loop packs sold as laps - package DoorDash BQR + Pallet recruiting for customer N+1
- **[CLI-945]** orb-slate 8: drop-in install - golden path to zero-papercut atris/ folder landing
- **[CLI-944]** orb-slate 7: second-brain check-ins - system schedules interviews to keep memory current
- **[CLI-943]** orb-slate 6: day loop cloned per operator - morning card + evening close for Justin next
- **[CLI-942]** orb-slate 5: plain-english approval queue - waiting-on-you as one sentence each, approvable from phone/SMS
- **[CLI-941]** orb-slate 4: watch the forward pass - live web view of the neural-net lap in atrisos-web
- **[CLI-940]** orb-slate 3: weights that update - receipts auto-tune engine/prompt routing nightly
- **[CLI-939]** orb-slate 2: one command one lap - atris <sentence> runs orb->navigator->engines->validator->plain-english receipt
- **[CLI-936]** one command to wake or sleep a single member and to turn a single loop on or off, local or cloud, and one line that tells me what that member is doing right now. atris sleep and wake exist for whole businesses, loops board shows everything, but there is no per-member or per-loop switch. confirming something is happening and being able to stop one thing fast is the point - speed is everything [wish]
- **[CLI-935]** rendering it in atrisos-web [wish]
- **[CLI-934]** this is about serving that projection through the backend [wish]
- **[CLI-933]** on the web i can see which members are awake and doing work, simply. i can see their actions and the loops that are running. the same view comes to our ios app later, desktop someday - for now the cloud versions. the data already exists in atris stream, task status --json, mission status, and the member alive loops [wish]
- **[CLI-932]** day-loop voice: own every sentence the justin day loop sends (morning one-thing, evening mirror, real-time warm ping). Standard = the 5-day simulation keshav approved in session 2026-07-08: plain, specific, one idea per beat, admits mistakes, never nags. Write the voice spec + message templates-as-guidance (not hardcoded strings) and the slop-gate rules for outbound coach messages.
- **[CLI-926]** a 2nd grade teacher at the same time: scientifically accurate, least jargon possible, fastest path to understanding [wish]
- **[CLI-925]** every explanation atris gives me should make sense to an ml researcher [wish]
  **Verify:** before/after of one real digest or result sentence + the doctrine diff
- **[CLI-915]** wish review latest resolves to an older open wish instead of the newest wish: reviewing 'latest' tonight hit yesterday's wish while today's decomposed wish existed; pin down the intended meaning of latest and add a test [wish]
- **[CLI-914]** get good results instead of generating from scratch [wish]
- **[CLI-913]** create deterministic code scripts for tasks llms are often asked to do, so a cheaper llm can just run the script [wish]
- **[CLI-912]** AgentXP Mode first rep: complete one proof-backed useful mission [agent-xp]

## In Progress

- **[CLI-966]** S6 activate boot line: build slice S6 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/activate-boot.test.js
  **Claimed by:** fleet-claude
- **[CLI-964]** S4 scoped push: build slice S4 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/push-scoped.test.js
  **Claimed by:** fleet-cursor
- **[CLI-963]** S3 cloud orphans: build slice S3 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/cloud-clean.test.js
  **Claimed by:** fleet-devin
- **[CLI-962]** S2 sync --review conflict handler: build slice S2 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/sync-review.test.js
  **Claimed by:** fleet-grok
- **[CLI-937]** our vision, in bullets: 1) the brain is the smartest place in the company - everything anyone does feeds it and everyone draws from it. 2) the day is the unit - every human gets one thing in the morning, a mirror at night, and gets measurably better every week. 3) loops run meaningfully on real reward - replies, shifts, revenue, outcomes - never motion. 4) the system maintains its own memory of people and work - member files, lessons, and surfaces never go stale and never get crowded. 5) humans keep only taste, priorities, and final accept - everything else is prepared for them before they ask. 6) agentgrads is the wedge - a scored, consented work shift anyone on earth can start from a link, and the fde market is where we win first. 7) every new person or agent activates at full context on day one - onboarding is activation, the company compounds instead of just growing [wish]
  **Claimed by:** fleet-claude
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
- **[CLI-910]** Make loops audit self-improving green [loops]
  **Claimed by:** auto-improver
  **Verify:** node bin/atris.js loops audit
- **[CLI-891]** Engine registry v2: .atris/state/engines.json (tier, roles, fallback order, health) + atris engine resolve <role> + engine list --json contract + mission --budget quick|long|deep tiers
  **Claimed by:** codex-engine-registry

## Review

(Empty)

## Blocked

- **[CLI-908]** i could see how this process would lead me to creating a viral hit on ableton [wish]
- **[CLI-907]** Wishes come true while everyone sleeps: queued wishes dispatch from the hourly loop instead of waiting for a live session, so the operator can wish at midnight and wake to landed work
- **[CLI-905]** Wish stops guessing wrong on big wishes: multi-part wishes get split or asked about instead of blind-delegated, budgets and proof come from the work not word-matching, and questions read like a person wrote them, so wishes can be trusted with anything
- **[CLI-904]** Flights verify in seconds: a fast real-behavior test tier becomes the default gate while the full suite moves to a background check, so every build lands minutes sooner without trusting mocks
- **[CLI-903]** quick tests with more real results so flights verify in seconds not minutes [wish]
- **[CLI-902]** One command proves the whole factory works: a golden-path drill runs wish to task to mission to landed merge against a sandbox repo and reports pass or the exact broken stage, so process breakage is caught in minutes not discovered mid-flight
- **[CLI-901]** Every plan the orchestrator hands a coder becomes a graded record: the brief, what came back, and the verdict live together, so plan quality is measured and improves instead of evaporating after each dispatch
- **[CLI-900]** the orb orchestrator always gives great plans to the executor coder and all the meta thinking is logged and organized to improve our thinking over time [wish]
- **[CLI-899]** Live team stream: one command shows what every agent is doing right now in plain rolling lines, per agent or whole team, so the operator understands everything at a glance instead of digging through logs
- **[CLI-898]** i could understand everything so fast in a stream for each agent or the whole team and that it was connected to GM mode so easily and the gm mode in project obelisk though it may seem hard [wish]
- **[CLI-897]** Wish speaks like a person: restates your words back, asks specific questions, names which wish it is granting, and never mangles grammar, so operators trust it on the first try
- **[CLI-896]** my roadmap till agi was ready [wish]

(32 older blocked tasks archived in `atris task list --status failed` and `atris task events`.)

## Completed

- **[CLI-968]** blocks spine slice 1: receipt block - one schema, four renderers (card/page/email/morning-card), brief atris/briefs/2026-07-10-blocks.md
  **Verify:** node --test test/receipt-block.test.js
- **[CLI-965]** S5 sync speed and watch alias: build slice S5 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/watch-alias.test.js
  **Verify:** node --test test/watch-alias.test.js Result
- **[CLI-960]** atris meet: onboard a stranger in one sitting - interview + init + theme + avail composed into one command that ends with their folder + live /book link
  **Verify:** node --test test/meet.test.js
- **[CLI-959]** Fix master CI red: 60+ failures since 7/05 (bench-agents merge-conflict, wish-bench floor, 15-min timeout)
  **Verify:** node --test test/bench-agents.test.js test/wish-bench-script.test.js
- **[CLI-938]** orb-slate 1: the interview - fuzzy asks get opinionated blanks before dispatch (wish-audit hook + taste doctrine)
  **Verify:** node --test test/wish-audit.test.js
- **[CLI-918]** six tests fail on master before tonight's work: mission status render pair, always-on due selection, wish short label review, and the two agent xp mission spine cases; each hides real drift between code and contract and blocks a trustworthy full-suite gate [cli]
  **Verify:** node --test test/mission-status.test.js test/mission-xp.test.js test/short-names.test.js test/mission-status-render.test.js
- **[CLI-916]** wish review latest resolves to an older open wish instead of the newest wish: reviewing latest tonight hit yesterday's wish while today's decomposed wish existed; pin down the intended meaning of latest and add a test [wish]
  **Verify:** node --test test/wish.test.js
- **[CLI-909]** Add atris loops init audit tick commands [cli]
  **Verify:** node --test test/loops.test.js

(396 older completed tasks archived in `atris task list --status done` and `atris task events`.)
