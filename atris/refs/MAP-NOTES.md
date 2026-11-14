# MAP notes: the deep map with rg shortcuts and file:line refs

The short routing table is `atris/MAP.md`. This page points to one note per area, each with exact `file:line` refs and `rg` search shortcuts. Open only the note your work touches. `atris doc-health` checks every line ref in these notes and `atris doc-health --fix-refs` moves the ones that drift.

- How `bin/atris.js` routes commands, the plain-English entry, flag parsing, chat and the ax app. Open [cli-entry.md](map/cli-entry.md) when you change how a command is dispatched, parsed or named.
- What runs when a session starts: activate, brain, setup, the first-minute view and the context gatherer. Open [boot-and-first-minute.md](map/boot-and-first-minute.md) when you touch session start, activation or the first screen a person sees.
- Login and logout, tokens and refresh, the API client, config files, the auto update check and portable local roots. Open [auth-and-config.md](map/auth-and-config.md) when you touch sign-in, credentials, API calls or where local state lives.
- The task database, claims, the task plane, task production readiness and returned jobs. Open [tasks.md](map/tasks.md) when you change how tasks are created, claimed, released or closed.
- Verification, code review, receipts, scorecards and the auto-accept gate. Open [review-and-receipts.md](map/review-and-receipts.md) when you change how work is checked, certified or proven.
- Autoland and its hourly pass, the landing contract, member worktrees and merge queues. Open [landing.md](map/landing.md) when you change how finished work lands on main or how working copies are made and reaped.
- Releases, version checks, publish and the balanced CI test groups. Open [release-and-tests.md](map/release-and-tests.md) when you cut a release or change how tests are grouped and run.
- The mission runtime: rooms, runners, ledgers, protected lanes and late pings. Open [missions.md](map/missions.md) when you change how a mission starts, runs, recovers or reports.
- Human-facing missions, goals, the overnight runner and the Codex goal bridge. Open [human-missions-and-goals.md](map/human-missions-and-goals.md) when you work on goals a person sets or the overnight runner.
- Campaign judges, traces, loops, cadence and learning reports. Open [campaigns.md](map/campaigns.md) when you change long goals that run until a judge passes.
- Autopilot and its legacy loop, the run front door, the pulse heartbeat, auto-advance and the wiki upkeep loop. Open [autopilot-and-loops.md](map/autopilot-and-loops.md) when you change an unattended loop or a tick.
- Improve, RSI, experiments, bench, compile, lessons and project learnings. Open [improvement-and-learning.md](map/improvement-and-learning.md) when you change how the system scores itself, runs experiments or keeps lessons.
- Member runs, wake announcements, goal loops, assigned jobs and member maintenance. Open [members.md](map/members.md) when you change how a team member is woken, run or handed work.
- The fleet that runs many members at once, the orb and zen. Open [fleet.md](map/fleet.md) when you change how parallel members are dispatched or summarized.
- The engine registry, engine resource readings and cleanup, runner commands, dispatch defaults and refusals, model pickers. Open [engines.md](map/engines.md) when you add an engine, change which model runs a job or debug a dispatch.
- The idea inbox, idea ticks and scores, wishes, teammate names and decisions. Open [ideas-and-wishes.md](map/ideas-and-wishes.md) when you work on how a raw idea or wish becomes work.
- XP, career records, ratings, balances and scoreboards. Open [scores-and-xp.md](map/scores-and-xp.md) when you change how work is counted or credited.
- Video notes, captions, search, watch and digest, plus X search and research sweeps. Open [youtube-and-research.md](map/youtube-and-research.md) when you work on the video notes rail or research tools.
- Business owners and computers, cloud sync, pull and push, sites and the local computer bridge. Open [business-and-cloud.md](map/business-and-cloud.md) when you touch business workspaces, sync or anything that runs in the cloud.
- Agent home and model publishing: `commands/agent-home.js:27` help, `commands/agent-home.js:46` routing, `commands/agent-home.js:54` agent lookup, `commands/agent-home.js:314` publish and unpublish, `commands/agent-home.js:398` command entry; `bin/atris.js:2326` dispatch; `test/agent-publish.test.js:1` checks.
- Agent always-on check-ins: `commands/agent-always-on.js:23` help, `commands/agent-always-on.js:40` --every parsing, `commands/agent-always-on.js:130` plain error lines, `commands/agent-always-on.js:171` bill printout, `commands/agent-always-on.js:225` command entry; `bin/atris.js:2321` dispatch; `test/agent-always-on.test.js:1` checks.
- Packs, apps, buying, Google and Slack integrations and outside CLI wrappers. Open [packs-apps-and-integrations.md](map/packs-apps-and-integrations.md) when you work on packs, apps or a connected account.
- Slop checks, voice, design checks, outbound gates, local HTTP server safety and the sentinel security audit. Open [quality-and-security.md](map/quality-and-security.md) when you change a quality gate or review security.
- Init, update, workflow, wiki, skills, doc health, the map tools and the hourly map note fold. Open [workspace-docs-and-maps.md](map/workspace-docs-and-maps.md) when you change workspace setup, docs, skills or these map notes.
- Daily logs, status, launchpad, analytics, briefs, recaps and visualize. Open [journals-and-briefs.md](map/journals-and-briefs.md) when you change journals, status views or summaries.
- Map notes from member changes that no area has claimed yet. Open [member-notes.md](map/member-notes.md) when no note above fits.

New notes go in the area note that owns the code. Keep each line ref next to the name of the function it points at so a moved line can be found again.
