# TODO.md

> Regenerated from durable Atris task state. Do not treat this file as truth.

## Endgame

**Slug:** wish-rides-itself
**Picked:** 2026-07-12 09:05
**Horizon:** Say a wish once and the system does the rest alone: one builder picks it up, builds it, checks it, delivers it, and reports back in one plain sentence. Proven the day a wish makes that full trip in the cloud without a human touching it.
**Source:** inbox-item (2026-07-10 I29 + I28; duplicate-flight lesson 7/09)

## Backlog

- **[CLI-1189]** The self-driving mission lane can land security-scoped changes with no human pre-land review, while every neighbouring lane blocks them, so the one loop that runs unattended overnight is the one lane with no guard. Verified 2026-07-25: DENIED_TAGS and the protected-lane text check exist in lib/fleet.js, lib/auto-accept-certified.js, commands/task.js and commands/brief.js, but commands/mission.js and lib/mission-{runtime-loop,room,root,artifact}.js reference none of them. Hit live: mission 6 tick 1 self-landed a CSP change to atrisos-web master (force-dynamic on a public page so it ships the nonce, commit 025099eb). That diff is correct and audit:static-routes passes, the problem is that nothing would have stopped a wrong one. This is the same hole that produced the WEB-448 incident, in a different lane. Done: a mission tick whose diff touches a protected lane (auth, session, CSP, billing, deploy) pauses for human review instead of landing, using the same text-plus-tag routing the task lane already has. Check: node --test test/mission*.test.js [security]
- **[CLI-1180]** one day someone says: atris, make me a million dollars, and it actually works. it creates the computer, the folder, the context. it sets up the storyline and the missions. it figures things out with the best intelligence and unblocks itself. it never writes generic output, no jargon ever reaches the human. the owner is at peace, out dancing in ibiza, and the businesses are just running. [wish]
- **[CLI-1169]** every pick logs one plain sentence saying which engine won and why. Stop after the registry reranker plus tests pass [wish]
- **[CLI-1166]** when a mission worker hits a usage wall and another headless engine is available, the loop swaps engines and keeps working instead of pausing for a human
- **[CLI-1165]** a wish that says delegated must have a live worker: dispatch verifies the engine actually started, and mission report never says working when there is no receipt and no driver
- **[CLI-1147]** a mission can carry a real dollar budget and atris mission report shows spent, what got done, and remaining in plain words, like: budget 100, spent 5, remaining 95, here is what you got [wish]
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
- **[CLI-1190]** When a fleet engine is killed mid-flight the next engine reports a rebase conflict that names no files, so the operator chases a merge problem that does not exist while real work sits uncommitted in the worktree. Hit live 2026-07-25 on WEB-455: the claude engine exited 143 (SIGTERM) with empty stderr and empty report, the fleet restaffed to codex, and the receipt came back stage rebase_conflict with conflicts:[]. The actual cause was that the killed predecessor left modified and untracked files in the worktree, so git rebase refused before any conflict could occur. The work was intact and landed fine after manual recovery. Done: a restaff onto a dirty worktree reports a distinct dirty_worktree state naming the uncommitted paths, an empty conflicts list is never reported as a conflict, and a killed engine leg records that it was signalled rather than showing an empty report. Check: node --test test/fleet*.test.js [web-quality]
  **Claimed by:** fleet-claude
- **[CLI-1186]** Fleet receipt truncates the head of a ship failure, hiding the cause. lib/fleet.js:2039 and :2365 slice(-300)/slice(-500) keep only the stack TAIL, so 'MODULE_NOT_FOUND: cannot find X' is cut and the operator sees five frames of node internals. Keep the first ~400 chars too (head+tail), since the error line leads. Done: a ship failure receipt names the failing module/command. Check: node --test test/fleet*.test.js [web-quality]
  **Claimed by:** fleet-cursor
- **[CLI-1183]** the radar says zero missions running while a claude worker is mid-flight on one, so the operator cannot trust the one screen meant to show everything; radar must count claude ticks and drop dead worktree rows [health]
  **Claimed by:** fleet-claude
- **[CLI-1182]** atris wish stream got swallowed as a new wish named stream, so any status check pollutes the wish list; reserved subcommands must never be treated as wish text [wish]
  **Claimed by:** fleet-codex
- **[CLI-1181]** the wish intake echoes a truncated title and asks the same three generic options for every wish, so the first thing an owner hears is mush; drill questions must come from the wish's own words [wish]
  **Claimed by:** fleet-codex
- **[CLI-1170]** one-lap flake: 'an unverifiable local ask dispatches with the repo default verifier' (test/one-lap-router.test.js:179) intermittently fails because the fake codex engine marker gets written, meaning one-lap sometimes really dispatches an ask it should refuse as stuck; nondeterministic product behavior, reproduced bare 2 of 3 runs on 2026-07-21; find the race and make the stuck path deterministic
  **Claimed by:** fleet-cursor
- **[CLI-1168]** it should say no worker has produced a receipt yet and name the command that starts one [wish]
  **Claimed by:** mission-lead
- **[CLI-1162]** Mission XP: Bounded Test Every Mission Room with improver [agent-xp]
  **Claimed by:** improver
  **Verify:** node --test test/voice-gate.test.js test/mission-status.test.js
- **[CLI-1156]** get a mission can carry a real dollar budget and moving again: max ticks reached [mission-blocker]
  **Claimed by:** fleet-codex
- **[CLI-1149]** Mission XP: Casa Naranja week one [agent-xp]
  **Claimed by:** researcher
  **Verify:** test -s atris/team/researcher/casa-naranja/week-one.md
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

- **[CLI-1195]** Engines finish work, commit it to a worktree, and it silently never lands, nine commits are stranded right now and the oldest is five days old, so the fleet looks productive while its output evaporates. Swept 2026-07-26 across atris-cli and atrisos-web worktrees, listing commits ahead of origin/master: dbf14daf cli status summaries, e6b83dd6 one-lap racing mission drivers, 5c87421b fleet receipt head (CLI-1186), ae661929 honest empty mission reports (2026-07-21), 7ddb00cf name the worker start command (2026-07-21), 89da102f GM overview honest and action-led, fe74de46 social connections across profiles, 1824d2f3 paywall lazy-load (WEB-455), 560254a1 mission tick summaries. Two were rescued by hand tonight (WEB-455 recovered from a SIGTERM-killed engine, CLI-1186 cherry-picked and landed as ec302673) and both were found only because someone went looking. Four of the nine cannot even rebase, their worktrees carry unstaged regenerated adapter files (AGENTS.md, CLAUDE.md, GEMINI.md, atris/TODO.md), which is CLI-1190. Nothing reports this: no receipt, no alarm, no digest line. Done: a worktree holding commits ahead of origin/master is surfaced, autoland reports stranded worktrees with their commit subjects and age, and reaping refuses to delete a worktree with unlanded commits unless explicitly forced. Check: node --test test/fleet*.test.js [web-quality]
- **[CLI-1193]** A fleet flight in this repo can kill the globally installed atris CLI for the whole machine, taking down every cron, loop and mission with it. Root cause found live 2026-07-26: /opt/homebrew/lib/node_modules/atris was an npm link pointing at an ephemeral fleet worktree (/Users/keshavrao/arena/.agent-worktrees/atris-cli/claude-fleet-cli-1188-20260725-210951). When that flight finished and its worktree was removed, /opt/homebrew/bin/atris became a dangling symlink and every atris invocation died with 'command not found', including the overnight autoland and mission crons. The failure is silent and total, and it looks like a shell/PATH problem rather than a worktree cleanup problem, so it costs real time to diagnose, this is the same shape as the cron PATH wedge that cost 20 days of autoland. Recovered by repointing the link at the real checkout. Done: a fleet flight never leaves the global CLI linked to a worktree, either it refuses to run npm link from a worktree, or worktree teardown restores the previous link target, and teardown verifies the CLI still runs before reporting success. Check: node --test test/fleet*.test.js [web-quality]
- **[CLI-1192]** A paused mission still reports itself as working with hours remaining, so an operator checking on an overnight loop is told everything is fine while nothing is running. Hit live 2026-07-25: mission f90e4c77 self-paused with pause_reason stuck-repeating after 3 ticks, and atris mission inspect correctly returned status paused, but atris mission status printed 'state: working for the full 140 minutes' and 'remaining 2h 5m' for ten minutes afterward. The only reason it was caught was cross-checking inspect against status. This is the harness-broken-must-never-read-as-fine rule inverted: stopped reading as healthy is worse than an error, because nobody investigates. Done: the human-readable mission status prints the paused state and the pause reason instead of a remaining-time commitment, and never shows time remaining for a mission that is not running. Check: node --test test/mission-*.test.js [web-quality]
- **[CLI-1191]** the slop detector silently ignores every path after the first, so a gate that names two files only guards one; multi-path detect must scan all of them or refuse loudly [health]
- **[CLI-1188]** A mission verifier that times out is reported as 'verifier failed', so operators read a slow suite as broken code and stop trusting the loop. Hit live: mission 5 in atrisos-web logged tick 2 as verifier-failed while that tick's own work was fine and the exact verifier passes clean at 81s (429 files, 3083 tests, exit 0), it only blew the 120s window because a fleet flight was running vitest concurrently. Done: a verifier that exceeds its window reports a distinct timed-out state, separate from a failing check, and the receipt records the elapsed time and the window. Check: node --test test/mission*.test.js [web-quality]
- **[CLI-1187]** the improve receipt lists every dirty file in the workspace as if the tick shipped them, so the owner cannot tell what actually changed; receipts must name only files the tick itself touched [health]
- **[CLI-1185]** Fleet ship gate dies with Node MODULE_NOT_FOUND while the verify itself passes, blocks 100% of fleet landings. Repro: atris mission run --fleet in atrisos-web staffs WEB-402, engine exits 0, then landArrival() pauses at stage:ship with a truncated cjs/loader stack (receipt atrisos-web/atris/runs/fleet-2026-07-25T18-12-40-594-p47746-1.json). Proven NOT a code break: the ship verify resolveDefaultVerifier()='npm test' passes clean in that same worktree (427 files / 3072 tests). Done: fleet ship either lands or reports the real cause. Check: node --test test/fleet*.test.js [web-quality]
- **[CLI-1177]** landed work does not reach local checkouts (backend sat stale for hours after a merge today): boot warns when the checkout is behind origin and a safe fast-forward sync closes the gap [health]
- **[CLI-1175]** context-engineering trim: CLAUDE.md/AGENTS.md gotchas-only across atris-cli, backend, web, terrace, obelisk (per Anthropic Claude 5 context guidance) [context]
- **[CLI-1174]** the new recover command shipped without tests, so mission recovery could silently break; add coverage for classify, report, and safe --apply
- **[CLI-1173]** a wish answered mid-interview can still double-dispatch its engine because the answer path spawns the background driver even for one-lap wishes; carry one-lap provenance on the wish record so only one dispatcher ever runs
- **[CLI-1172]** atris slop dead: deterministic dead-code detector (require-graph reachability)
- **[CLI-1171]** salvage the engine-resolve explanation surface: a stash on master named 'fragment-mission engine-explain WIP' has atris engine resolve printing one plain sentence why an engine won plus won_reason in JSON; re-cut it on top of the landed router brain (use routerPickExplanation from lib/router-brain.js instead of the stash's own explainEnginePick) and add the test back
- **[CLI-1167]** the mission report should never say work is continuing when no worker has checked in [wish]
- **[CLI-1164]** when I switch a mission's runner away from codex, the old codex approval gate should disappear so the loop keeps running instead of dying [wish]
- **[CLI-1163]** detached mission drivers never die silently: exit reason logged, always-on missions get a resumable driver
- **[CLI-1148]** Mission XP: Proof Build Validate Mission Room with architect [agent-xp]
- **[CLI-1146]** Mission XP: Build Numbers Pack Mission Room with mission-lead [agent-xp]
- **[CLI-1145]** cli smoke tests stop failing when the clock crosses midnight during a run

## Blocked

(Empty)

## Completed

- **[CLI-1184]** wishes are invisible in the desktop app because wish state never reaches the task projection, so the owner cannot watch the one flow that matters; publish wish status into the projection the app already reads [wish]
  **Verify:** node --test test/task-projection-missions.test.js exit 0
- **[CLI-1179]** boot reads wiki health and throws it away, so operators lost the one line telling them their memory is going stale; restore it through the voice gate [health]
  **Verify:** node --test test/activate-wiki-line.test.js exit 0
- **[CLI-1178]** the help text still calls atris loop a wiki upkeep loop, so anyone reading help gets sent to the wrong command; one line in bin/atris.js [health]
  **Verify:** node --test test/activate-wiki-line.test.js exit 0
- **[CLI-1176]** the generated CLAUDE.md boot block tells agents to re-run the boot that the SessionStart hook already ran, wasting a turn in every session: make the generator emit a hook-aware block (skip if hook present) [context]
  **Verify:** node --test test/claude-boot-block.test.js exit 0
- **[CLI-1161]** Boot block explains itself: activation output narrates what is happening instead of listing state
  **Verify:** node --test test/activate.test.js test/activate-boot.test.js
- **[CLI-1160]** Reviews queue explains itself: counts become sentences, each item says what you can do now and how to say yes
  **Verify:** node --test test/voice-gate.test.js
- **[CLI-1159]** Voice gate: one shared human-voice gate module, wire task reviews + mission status + autoland tick line through it
  **Verify:** node --test test/voice-gate.test.js
- **[CLI-1158]** orb loses the receipt when you quit before a background job finishes: write a dispatch record at spawn so the scorecard sees orphaned runs
  **Verify:** node --test test/orb.test.js

(10 older completed tasks archived in `atris task list --status done` and `atris task events`.)
