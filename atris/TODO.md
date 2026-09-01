# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** zero-revision-nights
**Picked:** 2026-08-26 00:48
**Horizon:** Overnight agent work lands itself and holds up, proven the day Keshav reviews a full night of landed changes and changes nothing.
**Source:** user-prompt (Lauren Tan talk, atris/wiki/briefs/youtube-Cmoh-yR-usA.md)

## Backlog

- **[CLI-1326]** half the 25-task agent exam moves to a private folder outside the repo; a nightly capped run scores held-out passes; the improve reward pays only on the increase over the last accepted baseline; landings-without-human-fix stays a health display that earns nothing. [improve]
  **Why it matters:** the current reward can be earned by shipping easy wins; a hidden held-out score is the one number that cannot be gamed by studying the test or cherry-picking work.
  **Done looks like:** a nightly run reports held-out passes inside a fixed budget, reward moves only when the number beats the accepted baseline, and a task the agents can read never appears in the held-out half.
  **Approve or change:** `atris task show CLI-1326` shows the actions allowed by the current plan and proof checks.
  **Technical details:** score the system on held-out tasks it cannot study, pay reward only on beating the baseline
  **Verify:** node --test test/heldout-score.test.js
- **[CLI-1322]** the ready gate refuses any claim that lacks a landed commit hash plus a check an independent runner executed on that hash, and a nightly disagreement rate counts claims whose named check fails or cannot be rerun.
  **Why it matters:** tonight a finished feature vanished with its temporary checkout while its done claim survived, so the loop can drift into fiction exactly where trust matters most.
  **Done looks like:** a planted claim without a landed commit is refused by the gate, and the nightly number catches a planted lie within one day.
  **Approve or change:** `atris task show CLI-1322` shows the actions allowed by the current plan and proof checks.
  **Technical details:** done means landed: a claim needs a main-line commit and an independent rerun on that exact commit
  **Verify:** node --test test/task-landed-claim.test.js
- **[CLI-1288]** Overnight fix crew: while we sleep, a second agent reads the day's failed checks and stuck work, then ships the fixes so mornings open with wins. [rsi]
  **Why it matters:** This is the one loop from the YC answer-key video we do not have. It is the difference between a product that improves overnight and one that waits for Keshav to wake up.
  **Done looks like:** For three straight mornings the daily journal opens with an honest list: what broke yesterday, what got fixed while everyone slept, each with a receipt.
  **Approve or change:** `atris task show CLI-1288` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Overnight fix crew: while we sleep, a second agent reads the day's failed checks and stuck work, then ships the fixes so mornings open with wins
- **[CLI-1276]** an hvac shop owner can install a ready pack and run invoice chasing, renewals, reviews, and call triage with honest ai workers.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** An HVAC owner can install a ready pack and run the four money jobs same day, which saves office evenings and builds trust because every run leaves a checkable receipt.
  **Approve or change:** `atris task show CLI-1276` shows the actions allowed by the current plan and proof checks.
  **Technical details:** an hvac shop owner can install a ready pack and run invoice chasing, renewals, reviews, and call triage with honest ai workers
- **[CLI-1251]** Turn the daily log into a simple product-work handoff so the right team member can act and validation closes the loop. [product-operations]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1251` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Turn the daily log into a simple product-work handoff so the right team member can act and validation closes the loop
- **[CLI-1250]** Make Atris.md the single voice rule so every agent gives clear next decisions.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1250` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Make Atris.md the single voice rule so every agent gives clear next decisions
- **[CLI-1156]** get a mission can carry a real dollar budget and moving again: max ticks reached. [mission-blocker]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1156` shows the actions allowed by the current plan and proof checks.
  **Technical details:** get a mission can carry a real dollar budget and moving again: max ticks reached
- **[CLI-1130]** get the first outside customer to pay for atris. [mission-blocker]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1130` shows the actions allowed by the current plan and proof checks.
  **Technical details:** get the first outside customer to pay for atris
- **[CLI-1127]** build the numbers pack from real records only, nothing estimated. [mission-blocker]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1127` shows the actions allowed by the current plan and proof checks.
  **Technical details:** build the numbers pack from real records only, nothing estimated
- **[CLI-1126]** keep every screen a person reads short and current. [mission-blocker]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1126` shows the actions allowed by the current plan and proof checks.
  **Technical details:** keep every screen a person reads short and current
- **[CLI-1125]** combine tools we already have into new product ideas. [mission-blocker]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1125` shows the actions allowed by the current plan and proof checks.
  **Technical details:** combine tools we already have into new product ideas
- **[CLI-979]** csrf gate should exempt cookie-less bearer-token api calls so every cli lane works without origin workarounds; protected lane, orb reviews pre-merge.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-979` shows the actions allowed by the current plan and proof checks.
  **Technical details:** csrf gate should exempt cookie-less bearer-token api calls so every cli lane works without origin workarounds; protected lane, orb reviews pre-merge
- **[CLI-966]** S6 activate boot line: build slice S6 exactly as specified in the named file verify: node test the named file.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Operators can now review fleet-shipped work faster because the worktree was verified before landing.
  **Approve or change:** `atris task show CLI-966` shows the actions allowed by the current plan and proof checks.
  **Technical details:** S6 activate boot line: build slice S6 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/activate-boot.test.js
- **[CLI-964]** S4 scoped push: build slice S4 exactly as specified in the named file verify: node test the named file.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Operators can now review fleet-shipped work faster because the worktree was verified before landing.
  **Approve or change:** `atris task show CLI-964` shows the actions allowed by the current plan and proof checks.
  **Technical details:** S4 scoped push: build slice S4 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/push-scoped.test.js
- **[CLI-963]** S3 cloud orphans: build slice S3 exactly as specified in the named file verify: node test the named file.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-963` shows the actions allowed by the current plan and proof checks.
  **Technical details:** S3 cloud orphans: build slice S3 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/cloud-clean.test.js
- **[CLI-962]** S2 sync review conflict handler: build slice S2 exactly as specified in the named file verify: node test the named file.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-962` shows the actions allowed by the current plan and proof checks.
  **Technical details:** S2 sync --review conflict handler: build slice S2 exactly as specified in atris/features/cloud-sync-simplicity/idea.md. verify: node --test test/sync-review.test.js
- **[CLI-958]** yo can you make me the best to do list ever. [wish]
  **Why it matters:** yo can you make me the best to do list ever.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-958` shows the actions allowed by the current plan and proof checks.
  **Technical details:** yo can you make me the best to do list ever
- **[CLI-957]** make me the best landing page ever. [wish]
  **Why it matters:** make me the best landing page ever.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-957` shows the actions allowed by the current plan and proof checks.
  **Technical details:** make me the best landing page ever
- **[CLI-952]** orb-slate 15: every lap launches itself - shipped work auto-produces the named file.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-952` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 15: every lap launches itself - shipped work auto-produces card/reel/post
- **[CLI-951]** orb-slate 14: overnight autoresearch as a customer dial - expose pulse the named file loop.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-951` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 14: overnight autoresearch as a customer dial - expose pulse prune/strengthen loop
- **[CLI-950]** orb-slate 13: wish-to-company - pooled capital into a wish, founders as approval queue.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-950` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 13: wish-to-company - pooled capital into a wish, founders as approval queue
- **[CLI-949]** orb-slate 12: self-staffing - shifts + XP ladder for humans and AI (AgentGrads checkout wiring).
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-949` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 12: self-staffing - shifts + XP ladder for humans and AI (AgentGrads checkout wiring)
- **[CLI-948]** orb-slate 11: the FDE exam - hackerrank for FDEs scored on real atris laps.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-948` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 11: the FDE exam - hackerrank for FDEs scored on real atris laps
- **[CLI-947]** orb-slate 10: receipts as compliance - receipt ledger as SOC2-grade evidence.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-947` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 10: receipts as compliance - receipt ledger as SOC2-grade evidence
- **[CLI-946]** orb-slate 9: loop packs sold as laps - package DoorDash BQR + Pallet recruiting for customer N+1.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-946` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 9: loop packs sold as laps - package DoorDash BQR + Pallet recruiting for customer N+1
- **[CLI-944]** orb-slate 7: second-brain check-ins - system schedules interviews to keep memory current.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-944` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 7: second-brain check-ins - system schedules interviews to keep memory current
- **[CLI-943]** orb-slate 6: day loop cloned per operator - morning card + evening close for Justin next.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-943` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 6: day loop cloned per operator - morning card + evening close for Justin next
- **[CLI-942]** orb-slate 5: plain-english approval queue - waiting-on-you as one sentence each, approvable from the named file.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-942` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 5: plain-english approval queue - waiting-on-you as one sentence each, approvable from phone/SMS
- **[CLI-941]** orb-slate 4: watch the forward pass - live web view of the neural-net lap in atrisos-web.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-941` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 4: watch the forward pass - live web view of the neural-net lap in atrisos-web
- **[CLI-940]** orb-slate 3: weights that update - receipts auto-tune the named file routing nightly.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-940` shows the actions allowed by the current plan and proof checks.
  **Technical details:** orb-slate 3: weights that update - receipts auto-tune engine/prompt routing nightly
- **[CLI-935]** rendering it in atrisos-web. [wish]
  **Why it matters:** rendering it in atrisos-web.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-935` shows the actions allowed by the current plan and proof checks.
  **Technical details:** rendering it in atrisos-web
- **[CLI-934]** this is about serving that shared view through the backend. [wish]
  **Why it matters:** this is about serving that shared view through the backend.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-934` shows the actions allowed by the current plan and proof checks.
  **Technical details:** this is about serving that projection through the backend
- **[CLI-933]** on the web i can see which members are awake and doing work, simply. i can see their actions and the loops that are running. the same view comes to our ios app later, desktop someday - for now the cloud versions. the data already exists in atris stream, task status json, mission status, and the member alive loops. [wish]
  **Why it matters:** on the web i can see which members are awake and doing work, simply. i can see their actions and the loops that are running. the same view comes to our ios app later, desktop someday - for now the cloud versions. the data already exists in atris stream, task status json, mission status, and the member alive loops.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-933` shows the actions allowed by the current plan and proof checks.
  **Technical details:** on the web i can see which members are awake and doing work, simply. i can see their actions and the loops that are running. the same view comes to our ios app later, desktop someday - for now the cloud versions. the data already exists in atris stream, task status --json, mission status, and the member alive loops
- **[CLI-931]** justin is connected as an operator - the system should give him ios notifications and a daily report. it should know what he's working on and be his coach inside this system. it should help him think about how to architect the system and hold him accountable on who he's reaching out to in the most effective way possible - encoded with smart language, not hardcoded rules. at the end of the day he says wow this system is so good, it's helping me. it has rainmaker and the other apps inside it so he can do his outreach from there - it brings the best out of him. [wish]
  **Why it matters:** justin is connected as an operator - the system should give him ios notifications and a daily report. it should know what he's working on and be his coach inside this system. it should help him think about how to architect the system and hold him accountable on who he's reaching out to in the most effective way possible - encoded with smart language, not hardcoded rules. at the end of the day he says wow this system is so good, it's helping me. it has rainmaker and the other apps inside it so he can do his outreach from there - it brings the best out of him.
  **Done looks like:** The operator now gets a coach-written morning and evening email from live workspace data, so the day starts with the one thing that matters.
  **Approve or change:** `atris task show CLI-931` shows the actions allowed by the current plan and proof checks.
  **Technical details:** justin is connected as an operator - the system should give him ios notifications and a daily report. it should know what he's working on and be his coach inside this system. it should help him think about how to architect the system and hold him accountable on who he's reaching out to in the most effective way possible - encoded with smart language, not hardcoded rules. at the end of the day he says wow this system is so good, it's helping me. it has rainmaker and the other apps inside it so he can do his outreach from there - it brings the best out of him
  **Verify:** python3 -m py_compile /Users/keshavrao/arena/atrisos-backend/scripts/day_loop.py
- **[CLI-930]** true two-part wishes split again and clarity stops stumbling on paint times, weekdays, and version numbers, so multi-ask wishes never silently lose their second half.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** You can ask for two things in one wish and both get built, which reduces the risk of work silently going missing and saves you re-asking.
  **Approve or change:** `atris task show CLI-930` shows the actions allowed by the current plan and proof checks.
  **Technical details:** true two-part wishes split again and clarity stops stumbling on paint times, weekdays, and version numbers, so multi-ask wishes never silently lose their second half
- **[CLI-929]** the wish intake reads 13 more real phrasings correctly: fresh visual idioms, two classifier overreaches, three clarity stumbles, one test idiom, so fuzzy wishes keep landing without questions or wrong turns.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** You can phrase a wish any way you like and it still reads correctly, which saves rework and increases trust that a build starts from your real ask.
  **Approve or change:** `atris task show CLI-929` shows the actions allowed by the current plan and proof checks.
  **Technical details:** the wish intake reads 13 more real phrasings correctly: fresh visual idioms, two classifier overreaches, three clarity stumbles, one test idiom, so fuzzy wishes keep landing without questions or wrong turns
- **[CLI-928]** every sentence the cli says to a human reads plain: no em dashes reaching your phone, no raw ids in wish replies, no shouting in the boot banner, 19 judged rewrites land.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Every message the command tool sends you reads like a person wrote it, so you act on it faster and trust it more: no ids, no shouting, no em dashes on your phone.
  **Approve or change:** `atris task show CLI-928` shows the actions allowed by the current plan and proof checks.
  **Technical details:** every sentence the cli says to a human reads plain: no em dashes reaching your phone, no raw ids in wish replies, no shouting in the boot banner, 19 judged rewrites land
- **[CLI-927]** wish intake understands fuzzy operator language: splitter, frontend detection, clarity questions, and verifier guesses stop misreading 38 confirmed real-world phrasings.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** You can type a wish with typos, run-ons, or mixed phrasing and the system reads your actual intent, saving rework and reducing the risk of nonsense tasks spawning.
  **Approve or change:** `atris task show CLI-927` shows the actions allowed by the current plan and proof checks.
  **Technical details:** wish intake understands fuzzy operator language: splitter, frontend detection, clarity questions, and verifier guesses stop misreading 38 confirmed real-world phrasings
- **[CLI-924]** atris improve front door: turn metabolism on and print vitals.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-924` shows the actions allowed by the current plan and proof checks.
  **Technical details:** atris improve front door: turn metabolism on and print vitals
- **[CLI-923]** pulse: per-repo state home so installs stop clobbering each other, plus restore fundraise loop.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** operators can now run self improving loops in every project at once, which reduces the risk of losing a nights work to one loop silently killing another.
  **Approve or change:** `atris task show CLI-923` shows the actions allowed by the current plan and proof checks.
  **Technical details:** pulse: per-repo state home so installs stop clobbering each other, plus restore fundraise loop
- **[CLI-922]** evolution sensors: usage jsonl + reaper and liveness scan adapters.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-922` shows the actions allowed by the current plan and proof checks.
  **Technical details:** evolution sensors: usage jsonl + reaper and liveness scan adapters
- **[CLI-921]** wish design brief: frontend wishes inject design the named file into mission room and default verify to audit:design.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Anyone can request a frontend change in fuzzy words and the builder already knows our design taste, saving time and reducing the risk of generic pages shipping.
  **Approve or change:** `atris task show CLI-921` shows the actions allowed by the current plan and proof checks.
  **Technical details:** wish design brief: frontend wishes inject design skill/policy/theme into mission room and default verify to audit:design
- **[CLI-920]** atris close scan: source adapters auto-open and auto-close flags from the named file files.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-920` shows the actions allowed by the current plan and proof checks.
  **Technical details:** atris close scan: source adapters auto-open and auto-close flags from tasks/missions/watch files
- **[CLI-919]** atris close: closure engine v1 (flag ledger + TTL escalation + operator-voice sweep).
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-919` shows the actions allowed by the current plan and proof checks.
  **Technical details:** atris close: closure engine v1 (flag ledger + TTL escalation + operator-voice sweep)
- **[CLI-912]** AgentXP Mode first rep: complete one proof-backed useful mission. [agent-xp]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-912` shows the actions allowed by the current plan and proof checks.
  **Technical details:** AgentXP Mode first rep: complete one proof-backed useful mission
- **[CLI-911]** member wake: warm human boot output (gm experience). [cli]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Operators can now trust what a waking team member is doing at a glance, because the wake screen explains its decision in plain words instead of raw codes.
  **Approve or change:** `atris task show CLI-911` shows the actions allowed by the current plan and proof checks.
  **Technical details:** member wake: warm human boot output (gm experience)

## In Progress

- **[CLI-1310]** a triage agent reproduces every piece of incoming feedback on its own computer before a human looks, reporting reproduced, already fixed, or cannot reproduce. Verify: node test the named file. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1310` shows the actions allowed by the current plan and proof checks.
  **Technical details:** a triage agent reproduces every piece of incoming feedback on its own computer before a human looks, reporting reproduced, already fixed, or cannot reproduce. Verify: node --test test/feedback-triage.test.js
  **Claimed by:** codex-feedback-triage
- **[CLI-1309]** every builder brief now orders atomic work: one concern per PR, split anything bigger, so git history stays a rich source of context and reverts stay cheap. Verify: node test the named file. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1309` shows the actions allowed by the current plan and proof checks.
  **Technical details:** every builder brief now orders atomic work: one concern per PR, split anything bigger, so git history stays a rich source of context and reverts stay cheap. Verify: node --test test/codex-flight-brief.test.js
  **Claimed by:** codex-atomic-briefs
- **[CLI-1308]** mistakes should file their own lessons: when a landed change gets revised twice for the same reason, the system writes the typed lesson itself instead of waiting for a human to notice. Verify: planted repeat-revision produces a new row in the named file without manual editing. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1308` shows the actions allowed by the current plan and proof checks.
  **Technical details:** mistakes should file their own lessons: when a landed change gets revised twice for the same reason, the system writes the typed lesson itself instead of waiting for a human to notice. Verify: planted repeat-revision produces a new row in atris/lessons.json without manual editing
  **Claimed by:** codex-auto-lessons
- **[CLI-1307]** RSI audit: read this endgame's halts, verify failures, and lessons; if the loop itself broke (parser, reward, scorecard, verify wiring) fix it, else no-op. Verify: npm test. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1307` shows the actions allowed by the current plan and proof checks.
  **Technical details:** RSI audit: read this endgame's halts, verify failures, and lessons; if the loop itself broke (parser, reward, scorecard, verify wiring) fix it, else no-op. Verify: npm test
  **Claimed by:** ox-alpha
- **[CLI-1306]** track revisions-after-landing as one number per landed change; a week at zero on gated lanes closes this endgame. Verify: metric file exists with 7 days of rows. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1306` shows the actions allowed by the current plan and proof checks.
  **Technical details:** track revisions-after-landing as one number per landed change; a week at zero on gated lanes closes this endgame. Verify: metric file exists with 7 days of rows
  **Claimed by:** codex-revision-metric
- **[CLI-1325]** the close sweep auto-closes any task-review flag whose watched task is already closed and accepted, recording the task id as proof, instead of leaving zombie reminders that eat queue slots. [improve]
  **Why it matters:** fifteen zombie reminders about already-accepted work were clogging the ten-slot queue on 2026-08-28 and had to be closed by hand.
  **Done looks like:** a sweep on a store holding a review flag for a closed task closes that flag with proof automatically; a flag for a still-open task survives.
  **Approve or change:** `atris task show CLI-1325` shows the actions allowed by the current plan and proof checks.
  **Technical details:** review-wait reminders close themselves when their task closes
  **Claimed by:** codex-zombie-autoresolve
  **Verify:** node --test test/close.test.js
- **[CLI-1324]** after a successful worktree ship, when no verified experiment ran in 24 hours, the ship report prints a failed health check line and files one probed close loop whose probe checks the experiments state file date. [improve]
  **Why it matters:** the separate heartbeat already died silently for 35 days; attaching the check to shipping means the one behavior that reliably happens carries the alarm.
  **Done looks like:** a ship on a stale experiment day prints the health check failure and opens exactly one probed loop; a ship within 24 hours of an experiment stays quiet; ships never block or slow on this.
  **Approve or change:** `atris task show CLI-1324` shows the actions allowed by the current plan and proof checks.
  **Technical details:** ship reports a failed health check when no experiment ran in 24 hours
  **Claimed by:** codex-ship-health
  **Verify:** node --test test/worktree-ship-health.test.js
- **[CLI-1318]** A mission started from a sentence gets a safe check automatically, and its first screen uses everyday language. [mission]
  **Why it matters:** People should be able to trust a mission and know what happens next without understanding Atris internals.
  **Done looks like:** A new mission always names how it will be checked, asks for no setup command, and keeps advanced details out of the first screen.
  **Approve or change:** `atris task show CLI-1318` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Mission starts with a real check and plain next step
  **Claimed by:** mission-lead
  **Verify:** node --test test/mission-plain-start.test.js test/mission-status.test.js
- **[CLI-1298]** Update fleet dispatch so a workspace whose protected remote branch is the named file can start an engine worktree instead of requiring the named file. [engine-dispatch]
  **Why it matters:** Atris Labs cannot dispatch the approved Next mission while its real protected branch is rejected.
  **Done looks like:** A focused test proves fleet dispatch accepts the named file when the named file is absent, and the existing Atris Labs dispatch gate no longer fails for that reason.
  **Approve or change:** `atris task show CLI-1298` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Let engine dispatch use the workspace's protected branch
  **Claimed by:** fleet-fable
  **Verify:** node --test test/fleet.test.js
- **[CLI-1297]** Make the full test suite green on master: fix the 19 chronic failures. [testing]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1297` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Make the full test suite green on master: fix the 19 chronic failures
  **Claimed by:** keshav
- **[CLI-1293]** agy joins the dispatch-capable list with yolo and sealed flag handling, and the overlap guard only refuses a second flight when it targets the same task instead of refusing all parallel work.
  **Why it matters:** tonight three parallel builds stalled one after another because any running flight blocked the next, and the newest engine cannot receive builds at all.
  **Done looks like:** two flights on distinct tasks run at once without force, an agy dispatch starts and lands, regression tests cover both.
  **Approve or change:** `atris task show CLI-1293` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Antigravity can take build dispatches like the other workers, and two builds on different tasks no longer block each other
  **Claimed by:** orb
  **Verify:** node --test test/engine-dispatch.test.js
- **[CLI-1267]** Quiet task board: make the cross-project task list show only work that needs attention now, so it can replace a noisy Linear board. [task-board]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The required check passes, the proof is attached, and review clears the work.
  **Approve or change:** `atris task show CLI-1267` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Quiet task board: make the cross-project task list show only work that needs attention now, so it can replace a noisy Linear board
  **Claimed by:** task-planner
  **Verify:** node --test test/task*.test.js
- **[CLI-1236]** every command reads flags consistently from one maintained parser. [cli]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Every command now reads flags through one parser, so a flag behaves the same everywhere and new commands stop hand-rolling parsing bugs.
  **Approve or change:** `atris task show CLI-1236` shows the actions allowed by the current plan and proof checks.
  **Technical details:** every command reads flags consistently from one maintained parser
  **Claimed by:** orb
- **[CLI-1231]** Pablo sees one honest pack card before expert diagnostics: what it is, where it lives, whether it is ready, why, and one next action. Keep inspect and doctor as drill-down. Done: atris pack show covers ready, revise, and reject; performs no network, execution, or mutation; stays within eight content lines. Check: node test the named file the named file. [pack]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1231` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Pablo sees one honest pack card before expert diagnostics: what it is, where it lives, whether it is ready, why, and one next action. Keep inspect and doctor as drill-down. Done: atris pack show covers ready, revise, and reject; performs no network, execution, or mutation; stays within eight content lines. Check: node --test test/pack-show.test.js test/pack-safety.test.js
  **Claimed by:** architect
- **[CLI-1209]** Mission XP: turn our hardest standing lessons into automatic. [agent-xp]
  **Why it matters:** turn our hardest standing lessons into automatic checks that fail loudly when broken, one lesson per tick, starting with the ones that have burned us twice: stale MAP file refs, prompt text naming commands that do not exist, and docs promising behavior no test enforces.
  **Done looks like:** The required check passes, the proof is attached, and review clears the work.
  **Approve or change:** `atris task show CLI-1209` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Mission XP: turn our hardest standing lessons into automatic
  **Claimed by:** builder
  **Verify:** npm test
- **[CLI-1194]** Decision rows look identical to work rows, so an autonomous lane will happily answer a question that was addressed to a human. The task system has no way to say 'this needs a judgement call, not an implementation', lane tags describe DOMAIN (billing, security, deploy) not whether autonomy is appropriate, so a policy question tagged web-quality is fully claimable and the fleet will staff it and pick a branch. Twice in one night on atrisos-web: (mount the notification bell into the dashboard, or delete it and its live backend) and (raise the failing total-bundle budget, or replace the metric). Both were written FOR Keshav; both sat claimable; an engine taking either would have silently decided product or guard policy. The only defence available was manually claiming each row to a human, because the fleet skips claimed rows, a workaround that depends on someone noticing. Done: a row can be marked as needing human judgement independently of its lane tag, autonomous lanes skip such rows the way they skip denied lanes, and the marker is visible in atris task list so it is not invisible to whoever files next. Check: node test test/task-*.test.js. [web-quality]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1194` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Decision rows look identical to work rows, so an autonomous lane will happily answer a question that was addressed to a human. The task system has no way to say 'this needs a judgement call, not an implementation', lane tags describe DOMAIN (billing, security, deploy) not whether autonomy is appropriate, so a policy question tagged web-quality is fully claimable and the fleet will staff it and pick a branch. Twice in one night on atrisos-web: WEB-453 (mount the notification bell into the dashboard, or delete it and its live backend) and WEB-458 (raise the failing total-bundle budget, or replace the metric). Both were written FOR Keshav; both sat claimable; an engine taking either would have silently decided product or guard policy. The only defence available was manually claiming each row to a human, because the fleet skips claimed rows, a workaround that depends on someone noticing. Done: a row can be marked as needing human judgement independently of its lane tag, autonomous lanes skip such rows the way they skip denied lanes, and the marker is visible in atris task list so it is not invisible to whoever files next. Check: node --test test/task-*.test.js
  **Claimed by:** orb
- **[CLI-1189]** The self-driving mission lane can land security-scoped changes with no human pre-land review, while every neighbouring lane blocks them, so the one loop that runs unattended overnight is the one lane with no guard. Verified 2026-07-25: DENIED TAGS and the protected-lane text check exist in the named file, the named file, the named file and the named file, but the named file and lib/mission-{runtime-loop,room,root,artifact}.js reference none of them. Hit live: mission 6 tick 1 self-landed a CSP change to atrisos-web master (force-dynamic on a public page so it ships the nonce, commit 025099eb). That diff is correct and audit:static-routes passes, the problem is that nothing would have stopped a wrong one. This is the same hole that produced the incident, in a different lane. Done: a mission tick whose diff touches a protected lane (auth, session, CSP, billing, deploy) pauses for human review instead of landing, using the same text-plus-tag routing the task lane already has. Check: node test test/mission*.test.js. [security]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1189` shows the actions allowed by the current plan and proof checks.
  **Technical details:** The self-driving mission lane can land security-scoped changes with no human pre-land review, while every neighbouring lane blocks them, so the one loop that runs unattended overnight is the one lane with no guard. Verified 2026-07-25: DENIED_TAGS and the protected-lane text check exist in lib/fleet.js, lib/auto-accept-certified.js, commands/task.js and commands/brief.js, but commands/mission.js and lib/mission-{runtime-loop,room,root,artifact}.js reference none of them. Hit live: mission 6 tick 1 self-landed a CSP change to atrisos-web master (force-dynamic on a public page so it ships the nonce, commit 025099eb). That diff is correct and audit:static-routes passes, the problem is that nothing would have stopped a wrong one. This is the same hole that produced the WEB-448 incident, in a different lane. Done: a mission tick whose diff touches a protected lane (auth, session, CSP, billing, deploy) pauses for human review instead of landing, using the same text-plus-tag routing the task lane already has. Check: node --test test/mission*.test.js
  **Claimed by:** architect
- **[CLI-1182]** atris wish stream got swallowed as a new wish named stream, so any status check pollutes the wish list; reserved subcommands must never be treated as wish text. [wish]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1182` shows the actions allowed by the current plan and proof checks.
  **Technical details:** atris wish stream got swallowed as a new wish named stream, so any status check pollutes the wish list; reserved subcommands must never be treated as wish text
  **Claimed by:** orb
- **[CLI-1168]** it should say no worker has produced a receipt yet and name the command that starts one. [wish]
  **Why it matters:** it should say no worker has produced a receipt yet and name the command that starts one.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1168` shows the actions allowed by the current plan and proof checks.
  **Technical details:** it should say no worker has produced a receipt yet and name the command that starts one
  **Claimed by:** mission-lead
- **[CLI-1165]** a wish that says delegated must have a live worker: dispatch verifies the engine actually started, and mission report never says working when there is no receipt and no driver.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1165` shows the actions allowed by the current plan and proof checks.
  **Technical details:** a wish that says delegated must have a live worker: dispatch verifies the engine actually started, and mission report never says working when there is no receipt and no driver
  **Claimed by:** orb
- **[CLI-1162]** Mission XP: Bounded Test Every Mission Room with improver. [agent-xp]
  **Why it matters:** Bounded Test Every Mission Room with improver: turn "Make the whole atris workspace work for 6 hours: each tick, find the worst broken thing - a blocked mission, a failing verifier, a red..." into one visible goal, task spine, proof receipt, and next action.
  **Done looks like:** The required check passes, the proof is attached, and review clears the work.
  **Approve or change:** `atris task show CLI-1162` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Mission XP: Bounded Test Every Mission Room with improver
  **Claimed by:** improver
  **Verify:** node --test test/voice-gate.test.js test/mission-status.test.js
- **[CLI-1149]** Mission XP: Casa Naranja week one. [agent-xp]
  **Why it matters:** Casa Naranja week one: the orange restaurant becomes a living mission. Research 8 SF locations suited to a day-shifting concept (morning coffee, afternoon workspace, evening orange-wine bar, night tasting menu) with outdoor seating and sunset light; draft the concept one-pager (orange as atmosphere: warmth, terracotta, golden hour; dishes across Indian, Thai, Mexican, Japanese); list 10 candidate chefs and 10 candidate investors with why-them lines; draft one outreach note each. Save everything under atris/team/researcher/casa-naranja/ with week-one.md as the spend report: what got done, what it would have cost a human, what is next.
  **Done looks like:** The required check passes, the proof is attached, and review clears the work.
  **Approve or change:** `atris task show CLI-1149` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Mission XP: Casa Naranja week one
  **Claimed by:** researcher
  **Verify:** test -s atris/team/researcher/casa-naranja/week-one.md
- **[CLI-1147]** a mission can carry a real dollar budget and atris mission report shows spent, what got done, and remaining in plain words, like: budget 100, spent 5, remaining 95, here is what you got. [wish]
  **Why it matters:** a mission can carry a real dollar budget and atris mission report shows spent, what got done, and remaining in plain words, like: budget 100, spent 5, remaining 95, here is what you got.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1147` shows the actions allowed by the current plan and proof checks.
  **Technical details:** a mission can carry a real dollar budget and atris mission report shows spent, what got done, and remaining in plain words, like: budget 100, spent 5, remaining 95, here is what you got
  **Claimed by:** orb
- **[CLI-1128]** run the four hour working session with mission-lead and show what it produced. [agent-xp]
  **Why it matters:** Hours Mission Room with mission-lead: turn "4 hours" into one visible goal, task spine, proof receipt, and next action.
  **Done looks like:** The required check passes, the proof is attached, and review clears the work.
  **Approve or change:** `atris task show CLI-1128` shows the actions allowed by the current plan and proof checks.
  **Technical details:** run the four hour working session with mission-lead and show what it produced
  **Claimed by:** mission-lead
  **Verify:** git diff --check
- **[CLI-1124]** run the two hour status session with mission-lead and show what it produced. [agent-xp]
  **Why it matters:** Hours Status Mission Room with mission-lead: turn "2 hours on status" into one visible goal, task spine, proof receipt, and next action.
  **Done looks like:** The required check passes, the proof is attached, and review clears the work.
  **Approve or change:** `atris task show CLI-1124` shows the actions allowed by the current plan and proof checks.
  **Technical details:** run the two hour status session with mission-lead and show what it produced
  **Claimed by:** mission-lead
  **Verify:** git diff --check
- **[CLI-1113]** Mission XP: Decide and start the next useful mission after: Repair the blocked operator-report mission by reproducing the live-update receipt failure, shipping one bounded verified fix, and continuing only after proof. [agent-xp]
  **Why it matters:** Decide and start the next useful mission after: Repair the blocked operator-report mission by reproducing the live-update receipt failure, shipping one bounded verified fix, and continuing only after proof.
  **Done looks like:** The next useful mission is now running, so work continues on faster control of individual members and loops without waiting for another manual choice.
  **Approve or change:** `atris task show CLI-1113` shows the actions allowed by the current plan and proof checks.
  **Technical details:** Mission XP: Decide and start the next useful mission after: Repair the blocked operator-report mission by reproducing the live-update receipt failure, shipping one bounded verified fix, and continuing only after proof.
  **Claimed by:** linguist
- **[CLI-984]** the named file:645 worktree-target test fails on master (expects /feature work/, gets '54d8fe6 init'); pre-existing before PR 342, confirmed on merge parents 91cbcb3 and 52595ec on 2026-07-09.
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-984` shows the actions allowed by the current plan and proof checks.
  **Technical details:** test/commands.test.js:645 worktree-target test fails on master (expects /feature work/, gets '54d8fe6 init'); pre-existing before PR 342, confirmed on merge parents 91cbcb3 and 52595ec on 2026-07-09
  **Claimed by:** keshavrao

## Review

(Empty)

## Blocked

- **[CLI-1198]** the member wake test passes alone but fails when the full suite runs before it, so a red suite can point at the wrong culprit; find the state it inherits (likely env or homedir bleed) and isolate it. [health]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1198` shows the actions allowed by the current plan and proof checks.
  **Technical details:** the member wake test passes alone but fails when the full suite runs before it, so a red suite can point at the wrong culprit; find the state it inherits (likely env or homedir bleed) and isolate it
- **[CLI-1197]** A stranded commit would silently delete the entire test coverage for the mission-lane diff guard, leaving the guard implemented but unprotected against future breakage. Found 2026-07-26 in worktree the named file, commit ea7084bd 'mission ticks hold before firing when the mission sits in a protected lane'. The ADDITION is good and worth keeping: a pre-tick hold that pauses a mission sitting in a protected lane before any tick fires, releasing only on explicit human ack, genuine defence in depth, since stopping before work starts beats stopping at commit time. The PROBLEM is what it removes. It deletes 262 lines from the named file, taking out all eight diff-inspection tests: a clean diff reaches the landing callback, a CSP diff pauses and names the surface, an auth-header diff pauses from changed CONTENT on a neutral path, an unreadable diff fails closed, a denied tag pauses when text looks neutral, the git-wrapper leaves a protected change staged, a protected tick writes the matched surface to its receipt, and the Atris2 relay keeps the wrapper first on PATH. It replaces them with four tests that only check lane tags and objective text. match Protected Mission Diff appears zero times in the resulting test file, while remaining present three times in lib and wired four times in the named file, so the implementation survives with no coverage. That is precisely the hole exists to close: a mission GENERATES its own work, so its objective can be innocuous while its tick writes a CSP change. That is not hypothetical, mission 6 tick 1 self-landed force-dynamic on a public page under the objective 'next bounded improvement'. Objective-text routing cannot catch that; only diff inspection can. Done: the pre-tick hold lands AND every deleted diff-inspection test is restored, so both gates are covered. Check: node test the named file. [security]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The owner shows proof the work is real and it clears review.
  **Approve or change:** `atris task show CLI-1197` shows the actions allowed by the current plan and proof checks.
  **Technical details:** A stranded commit would silently delete the entire test coverage for the mission-lane diff guard, leaving the guard implemented but unprotected against future breakage. Found 2026-07-26 in worktree .agent-worktrees/atris-cli/architect-mission-protected-lane-gate-20260726-083719, commit ea7084bd 'mission ticks hold before firing when the mission sits in a protected lane'. The ADDITION is good and worth keeping: a pre-tick hold that pauses a mission sitting in a protected lane before any tick fires, releasing only on explicit human ack — genuine defence in depth, since stopping before work starts beats stopping at commit time. The PROBLEM is what it removes. It deletes 262 lines from test/mission-protected-lane.test.js, taking out all eight diff-inspection tests: a clean diff reaches the landing callback, a CSP diff pauses and names the surface, an auth-header diff pauses from changed CONTENT on a neutral path, an unreadable diff fails closed, a denied tag pauses when text looks neutral, the git-wrapper leaves a protected change staged, a protected tick writes the matched surface to its receipt, and the Atris2 relay keeps the wrapper first on PATH. It replaces them with four tests that only check lane tags and objective text. matchProtectedMissionDiff appears zero times in the resulting test file, while remaining present three times in lib and wired four times in commands/mission.js — so the implementation survives with no coverage. That is precisely the hole CLI-1189 exists to close: a mission GENERATES its own work, so its objective can be innocuous while its tick writes a CSP change. That is not hypothetical — mission 6 tick 1 self-landed force-dynamic on a public page under the objective 'next bounded improvement'. Objective-text routing cannot catch that; only diff inspection can. Done: the pre-tick hold lands AND every deleted diff-inspection test is restored, so both gates are covered. Check: node --test test/mission-protected-lane.test.js

## Completed

- **[CLI-1305]** eliminate: delete every reviewer checklist line that a hard gate now enforces, review stops re-checking what CI already rejects. Verify: grep shows removed lines gone and gate tests cover each. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Reviewers no longer re-check the things the build already rejects, so review attention goes only to real judgment calls.
  **Approve or change:** `atris task show CLI-1305` shows the actions allowed by the current plan and proof checks.
  **Technical details:** eliminate: delete every reviewer checklist line that a hard gate now enforces, review stops re-checking what CI already rejects. Verify: grep shows removed lines gone and gate tests cover each
  **Verify:** git diff --check
- **[CLI-1304]** gate skill edits behind an eval: any SKILL.md change must pass a judge run on a fixed rubric before landing. Verify: planted bad skill edit gets rejected by the gate, receipt in scorecards. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** A change to any skill now needs a fresh passing evaluation from an independent judge before it can land, so a bad skill edit can no longer ship silently.
  **Approve or change:** `atris task show CLI-1304` shows the actions allowed by the current plan and proof checks.
  **Technical details:** gate skill edits behind an eval: any SKILL.md change must pass a judge run on a fixed rubric before landing. Verify: planted bad skill edit gets rejected by the gate, receipt in scorecards
  **Verify:** git diff --check
- **[CLI-1303]** write a feature map for one running surface (ax TUI): screens, selectors, keyboard shortcuts in one markdown file, and make one agent verify a change by driving the real product with it. Verify: test -f the named file. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** Agents working on the ax chat app now get a map of its screens, keys, and commands, so they can drive the real app to prove a change instead of guessing from the code.
  **Approve or change:** `atris task show CLI-1303` shows the actions allowed by the current plan and proof checks.
  **Technical details:** write a feature map for one running surface (ax TUI): screens, selectors, keyboard shortcuts in one markdown file, and make one agent verify a change by driving the real product with it. Verify: test -f atris/refs/FEATURE-MAP-ax.md
  **Verify:** git diff --check
- **[CLI-1302]** turn the three most-repeated review corrections into predictable checks that fail the build, sitting next to the slop and hygiene gates. Verify: node test the named file green plus three new named tests each red on a planted violation. [endgame]
  **Why it matters:** The task does not say why this matters yet.
  **Done looks like:** The three corrections we kept repeating in review now fail the build by themselves, so reviewers never have to say them again.
  **Approve or change:** `atris task show CLI-1302` shows the actions allowed by the current plan and proof checks.
  **Technical details:** turn the three most-repeated review corrections into deterministic checks that fail the build, sitting next to the slop and hygiene gates. Verify: node --test test/hygiene-ratchet.test.js green plus three new named tests each red on a planted violation
  **Verify:** git diff --check
- **[CLI-1323]** cap the closure queue at ten active slots with a parked log: an open loop must have an action the system can take now plus a machine-checkable closing test. [wish]
  **Why it matters:** the closure queue holds at most ten active loops, each with a now-action and a machine-checkable closing test; everything else lives in a searchable parked log via atris close park <id> and atris close parked, reopenable with atris close reopen <id>; when ten slots are full, close add refuses unless the new loop closes, merges with, or replaces an existing one; first sweep after upgrade migrates existing loops, parking any that fail the slot test.
  **Done looks like:** the problem queue now holds only ten things the system can act on now, and the rest waits in a searchable parked list, so real work stops drowning in stale reminders.
  **Approve or change:** `atris task show CLI-1323` shows the actions allowed by the current plan and proof checks.
  **Technical details:** cap the closure queue at ten active slots with a parked log: an open loop must have an action the system can take now plus a machine-checkable closing test
  **Verify:** node --test test/close-park.test.js test/close.test.js test/close-probe.test.js
- **[CLI-1321]** every triage verdict row also stores why: which rule fired and the visible facts like list headers or a noreply sender, and a summary view shows per-account keep and archive counts by day.
  **Why it matters:** a week from now we mine these rows for the owner's signal bar, and rows that carry their own why make that mining honest instead of guesswork.
  **Done looks like:** reading the log alone explains every verdict, and one command shows how the week of decisions is filling in.
  **Approve or change:** `atris task show CLI-1321` shows the actions allowed by the current plan and proof checks.
  **Technical details:** each recorded inbox verdict carries the plain facts that explain it, and a one-line daily summary shows the log growing
  **Verify:** git diff --check
- **[CLI-1320]** the process-tree cleanup test and the mission budget test stop using fixed sleeps and instead poll until the condition is true or a real deadline passes.
  **Why it matters:** each false alarm stalls a release behind reruns, so shipping gets slower and trust in red goes down.
  **Done looks like:** three consecutive full-suite runs under load come back green with no reruns.
  **Approve or change:** `atris task show CLI-1320` shows the actions allowed by the current plan and proof checks.
  **Technical details:** two timing-flaky tests cry wolf under full-suite load and block releases
  **Verify:** git diff --check
- **[CLI-1319]** atris gmail triage reads recent inbox mail per account, decides keep or archive for each message with plain predictable rules, and records every decision in the verdict log without touching the mailbox.
  **Why it matters:** rung two of the inbox ladder: a week of real keep and archive decisions on disk is the raw material the quiet inbox learns from.
  **Done looks like:** running one triage pass on any account leaves both keep and archive verdicts in the log, and the tests prove it.
  **Approve or change:** `atris task show CLI-1319` shows the actions allowed by the current plan and proof checks.
  **Technical details:** gmail triage writes keep and archive verdicts on a schedule-ready command
  **Verify:** node --test /Users/keshavrao/arena/.agent-worktrees/atris-cli/codex-gmail-triage-verdicts-20260828-061740/test/gmail-triage.test.js

(141 older completed tasks archived in `atris task list --status done` and `atris task events`.)
