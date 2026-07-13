# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** wish-rides-itself
**Picked:** 2026-07-12 09:05
**Horizon:** A wish spoken once travels the whole pipeline unattended — intake, single dispatch (no duplicate flights), build, verify, land, one plain-sentence receipt — proven by a live cloud fast-lane round trip.
**Source:** inbox-item (2026-07-10 I29 + I28; duplicate-flight lesson 7/09)

## Backlog

- **[CLI-1122]** make first-run onboarding land: a fresh laptop with a new atris folder reaches a working first wish without help, gaps fixed as found (reshapes wish CLI-895) [wish]
- **[CLI-1121]** revalidate stale feature packs: heal drifted line refs, rerun rubric checks, bump last_compiled (revives CLI-222) [maintenance]
- **[CLI-1120]** recompile the stale wiki pages that feed agent boot: systems/atris-cli, overview brief, concepts (revives CLI-221) [maintenance]
- **[CLI-1119]** heal workspace drift: stale MAP.md line refs and old journals via atris clean, then rerun the drift count to prove it dropped (revives CLI-220) [maintenance]
- **[CLI-1118]** fix skill audit false-fails: no-xml-tags rule flags placeholders inside code blocks, failing 9 healthy skills (revives CLI-223) [maintenance]
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
- **[CLI-936]** one command to wake or sleep a single member and to turn a single loop on or off, local or cloud, and one line that tells me what that member is doing right now. atris sleep and wake exist for whole businesses, loops board shows everything, but there is no per-member or per-loop switch. confirming something is happening and being able to stop one thing fast is the point - speed is everything [wish]
- **[CLI-935]** rendering it in atrisos-web [wish]
- **[CLI-934]** this is about serving that projection through the backend [wish]
- **[CLI-933]** on the web i can see which members are awake and doing work, simply. i can see their actions and the loops that are running. the same view comes to our ios app later, desktop someday - for now the cloud versions. the data already exists in atris stream, task status --json, mission status, and the member alive loops [wish]
- **[CLI-914]** get good results instead of generating from scratch [wish]
- **[CLI-913]** create deterministic code scripts for tasks llms are often asked to do, so a cheaper llm can just run the script [wish]
- **[CLI-912]** AgentXP Mode first rep: complete one proof-backed useful mission [agent-xp]

## In Progress

- **[CLI-1123]** master test board is red again after the map-reference healing change; fix the clean dry-run heal test so real breakage is visible to everyone [maintenance]
  **Claimed by:** mission-lead
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
- **[CLI-939]** orb-slate 2: one command one lap - atris <sentence> runs orb->navigator->engines->validator->plain-english receipt
  **Claimed by:** mission-lead
  **Verify:** A real-runtime test with a temp Git remote and executable engine fixture must invoke node bin/atris.js with one quoted sentence, prove the exact task was built and verified, prove origin/master was not silently changed by default, and show the task/receipt evidence is Review-ready.
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
- **[CLI-891]** Engine registry v2: .atris/state/engines.json (tier, roles, fallback order, health) + atris engine resolve <role> + engine list --json contract + mission --budget quick|long|deep tiers
  **Claimed by:** codex-engine-registry

## Review

- **[CLI-1117]** rsi audit for endgame wish-rides-itself: read this endgame's halts, verify failures, and lessons; repair the loop itself if it broke, no-op otherwise; verify with npm test [endgame]
  **Verify:** node --test test/mission-idle-stop.test.js
- **[CLI-1116]** wish receipt speaks operator voice: completion surfaces one plain sentence (what + how we know), no ulids or command dumps, covered by a test on the receipt renderer [endgame]
  **Verify:** node --test test/wish.test.js
- **[CLI-1114]** duplicate-flight guard: a second dispatch for the same wish slice (repeat wish or manual engine dispatch) is detected and refused or attached instead of launching a parallel flight; add a regression test [endgame]
  **Verify:** node --test test/wish.test.js
- **[CLI-1113]** Mission XP: Decide and start the next useful mission after: Repair the blocked operator-report mission by reproducing the live-update receipt failure, shipping one bounded verified fix, and continuing only after proof. [agent-xp]
- **[CLI-1112]** Mission XP: Repair the blocked operator-report mission by reproducing the live-update receipt failure, shipping one bounded verified fix, and continuing only after proof. [agent-xp]
  **Verify:** node --test test/autoland.test.js
- **[CLI-1110]** Improve vitals names the scheduled loop so active missions do not look idle [voice]
  **Verify:** node --test test/improve-vitals.test.js
- **[CLI-1108]** Mission history removes internal ids and verifier commands so full proof stays readable [voice]
  **Verify:** node --test --test-name-pattern='mission timeline cleans internal ids and verifier tails from history' test/mission-status.test.js
- **[CLI-1107]** Task status closes long current titles at a clause so operators can act [voice]
  **Verify:** node --test --test-name-pattern='task status closes long current titles at a clause' test/commands.test.js
- **[CLI-1106]** Autoland status calls protected work a review until it is ready to approve [voice]
  **Verify:** node --test --test-name-pattern='autoland status does not call one-pass protected work approval-ready' test/autoland.test.js
- **[CLI-1105]** Goal controller labels active budget as hold so completion line stays clear [voice]
  **Verify:** node --test --test-name-pattern='visible goal bridge holds completion for full budget' test/mission-status.test.js
- **[CLI-1104]** Daily digest includes protected reviews so approval count matches autoland [voice]
  **Verify:** node --test --test-name-pattern='digest reports protected reviews before certification' test/autoland.test.js
- **[CLI-1102]** Goal controller card keeps active goals from looking blocked or needing creation [voice]
  **Verify:** node --test --test-name-pattern='goal controller card distinguishes active goal from required write' test/mission-status.test.js
- **[CLI-1099]** Mission inspect shows live budget so compact status does not contradict report [voice]
  **Verify:** node --test --test-name-pattern='mission inspect shows live budget in text' test/mission-status.test.js
- **[CLI-1098]** Mission report follows live budget so operators do not review early [voice]
  **Verify:** node --test --test-name-pattern='mission report keeps full-budget work active' test/mission-status.test.js
- **[CLI-1095]** Digest withholds duplicate mission review during active full-budget run [voice]
  **Verify:** node --test --test-name-pattern='digest next moves withhold duplicate objective review' test/autoland.test.js
- **[CLI-1020]** Landing gate counts audience words as a reason, letting action-only reports pass without saying why they matter [voice]
  **Verify:** node --test test/autoland.test.js

## Blocked

(Empty)

## Completed

- **[CLI-1115]** live proof of wish-to-cloud: fire a one-sentence hello wish on the cloud fast lane and capture the receipt to the receipt ledger [endgame]
  **Verify:** git diff --check
- **[CLI-1111]** Rate-limit fixture disables the idle breaker so the command suite tests one boundary [test]
  **Verify:** node --test --test-name-pattern='allowed rate-limit info with a future resetsAt does not pause a timed run' test/commands.test.js
- **[CLI-1109]** Mission locks reap dead owners so interrupted work can recover immediately [reliability]
  **Verify:** node --test --test-name-pattern='mission lock reaps a dead owner before acquiring' test/mission-status.test.js
- **[CLI-1103]** Goal handshake keeps matching native goal active through the full budget [safety]
  **Verify:** node --test --test-name-pattern='goal handshake keeps matching native goal active for full budget' test/mission-status.test.js
- **[CLI-1101]** Visible goal bridge holds completion until full budget ends [safety]
  **Verify:** node --test --test-name-pattern='visible goal bridge holds completion for full budget' test/mission-status.test.js
- **[CLI-1100]** Native goal bridge continues live budget so agents do not review early [safety]
  **Verify:** node --test --test-name-pattern='native goal bridge keeps full-budget mission working' test/mission-status.test.js
- **[CLI-1097]** Mission goal help stays read-only so discovery cannot launch work [safety]
  **Verify:** node --test --test-name-pattern='mission help documents status filters' test/mission-status.test.js
- **[CLI-1094]** Mission layers and prune help stay read-only [mission]
  **Verify:** node --test --test-name-pattern='mission help documents status filters' test/mission-status.test.js

(428 older completed tasks archived in `atris task list --status done` and `atris task events`.)
