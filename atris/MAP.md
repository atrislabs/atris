# MAP.md: atris-cli navigation

This repo builds the `atris` CLI (Node, zero dependencies). Entry is
`bin/atris.js`; command handlers live in `commands/`, shared helpers in `lib/`,
API and auth in `utils/`, tests in `test/`. Workspace truth lives in `atris/`:
tasks in the task DB rendered to `atris/TODO.md`, protocol in `atris/atris.md`,
members in `atris/team/`, feature specs in `atris/features/`.

File:line refs and rg search shortcuts live in `atris/refs/MAP-NOTES.md`. Open it
when this table names the file but you need the exact line. `atris doc-health`
checks the refs in both files; `atris doc-health --fix-refs` moves drifted ones.

## Routing

| Task | Primary path | Notes |
|------|--------------|-------|
| cli entrypoint and command router | `bin/atris.js` | dispatch chain, knownCommands, help |
| known commands list | `lib/known-commands.js` | command names and typo suggestions defined via `suggestCommands` |
| plain english to a command | `lib/intents.js`, `commands/guide.js` | `atris guide`; maps natural phrases to CLI commands |
| project initialization | `commands/init.js`, `commands/sync.js`, `lib/gitignore.js` | project initialization implemented here; `init` and `update` scaffold user projects |
| first minute boot flow | `lib/first-minute.js`, `commands/activate.js`, `lib/context-gatherer.js` | bare `atris` screen, context activation, and first-contact gatherer |
| atris done command | `commands/done.js` | land what a coding agent built: check, accept, sign |
| working values | `atris.md`, `lib/values.js`, `lib/opening-lines.js` | the four values (acceleration, accuracy, ambition, agency) shown at boot |
| boot files an agent starts with | `commands/init.js`, `scripts/member-lab.js`, `scripts/boot-tokens.js`, `scripts/boot-usage.js` | lean agent instructions, member benchmark lab, and boot token measurements |
| workspace protocol and voice | `atris/atris.md`, `atris/PERSONA.md`, `atris/skills/atris/SKILL.md` | operating protocol, communication style, and workspace skill |
| brain compile command | `commands/brain.js` | brain artifacts compiled and verified here |
| document health | `commands/doc-health.js`, `lib/map-refs.js`, `atris/doc-health/questions.jsonl` | document health measurements calculated here: boot size, map coverage, lookup hops, freshness, line refs |
| doctor health check | `commands/doctor.js` | workspace readiness checked by doctor |
| slop detector | `commands/slop.js` | deterministic prose lint wired into review |
| workspace tree hash | `commands/tree.js`, `lib/tree-hash.js` | `atris tree hash` over the doctrine files |
| task database and TODO markdown renderer | `lib/task-db.js`, `lib/todo-fallback.js` | SQLite task store, serialized result/review writes and command metadata stamps, claim leases, `renderTodoMarkdown`, legacy fallback |
| task command surface and projection | `commands/task.js`, `lib/task-core.js`, `lib/task-list-keeper.js` | task claims, shared task helpers, and proof handled here: claim, sweep, ready, accept, render, keep, day, `.atris/state/tasks.projection.json` |
| test home state fence | `lib/state-home.js`, `commands/sync.js`, `lib/member-progress.js` | redirects `~/.atris` state to a throwaway folder under `node --test` |
| test junk cleanup in the task database | `lib/task-prune.js`, `commands/task.js` | `atris task prune-test-junk` backs up and removes rows from deleted temp folders |
| task verification receipts and job-code checks | `lib/task-receipt.js`, `lib/job-code-verify.js`, `lib/verify-worktree-rewrite.js` | bounded verification receipts, scratch-checkout checks at the job's own commit, and worktree path rewrites |
| certification and auto-accept gates | `lib/accept-verify-gate.js`, `lib/auto-accept-certified.js`, `lib/voice-gate.js` | requires falsifying checks, blocks solo whitespace checks, holds protected money/people lanes for a human |
| idle review sweep and merged work close | `lib/idle-review-sweep.js`, `lib/merged-review-close.js`, `commands/autoland.js` | hourly pass closes unrunnable stale review rows and review jobs whose commits already merged |
| trust tiers and AgentXP ledger | `lib/trust-tiers.js`, `commands/xp.js`, `lib/career-xp-root.js`, `lib/career-xp-lock.js` | earned autonomy tiers by builder and shared accepted-work XP ledger across linked checkouts |
| autoland gate and command | `commands/autoland.js`, `lib/autoland.js`, `lib/member-autoland.js` | certified landings, local no-remote landing, requeue of dropped changes, and post-mission merge sweep |
| zen state and boot cleanup line | `commands/zen.js`, `lib/zen.js`, `lib/zen-apply.js`, `lib/zen-workspace.js`, `lib/zen-fleet.js`, `lib/cleanup-summary.js` | `atris zen` archives stashes/side copies, fast-forwards notes, runs `atris clean`, and summarizes overnight state |
| mission command and root resolver | `commands/mission.js`, `lib/mission-core.js`, `lib/mission-root.js` | workspace root resolved in `lib/mission-root.js`; shared mission helpers in `lib/mission-core.js`; mission start, run, tick, complete, and resource readings in `commands/mission.js` |
| campaign command, store, and schedule | `commands/campaign.js`, `lib/campaign-core.js`, `lib/campaign-store.js`, `lib/campaign-new.js`, `lib/campaign-keep.js`, `lib/campaign-schedule.js` | long goals with drafted judge, budget, wake timer, schedule slots, and conformance checks (`scripts/campaign-conformance.js`) |
| campaign loop, trace, and RSI learning | `lib/campaign-loop.js`, `lib/campaign-trace.js`, `lib/campaign-rsi.js`, `lib/campaign-reading.js`, `lib/campaign-cadence.js`, `lib/mission-code-provenance.js` | campaign steps, judge reset boundaries, compact trace lookups, reward precision, and worker ranking |
| campaigns skill and MCP tools | `atris/skills/campaigns/SKILL.md`, `mcp/atris-mcp/index.mjs` | how agents run campaigns; `atris mcp` serves campaign and design tools over stdio JSON-RPC |
| engine profiles, roster, and model swap | `commands/engine.js`, `lib/engine-registry.js`, `lib/runner-command.js`, `lib/roster-markdown.js`, `lib/roster-models.js`, `lib/roster-swap.js` | `atris/ROSTER.md` routing, `engine roster set`, model/effort/cap precedence, and notes job resolution |
| roster runs, prep briefs, and suggestions | `lib/roster-runs.js`, `lib/roster-prep.js`, `lib/roster-suggest.js`, `lib/router-brain.js` | `.atris/state/roster_runs.jsonl` rotation, read-only `prep: search` briefs, and promote suggestions |
| engine resource readings and ssh-agent sweep | `lib/engine-resource.js`, `commands/engine.js`, `scripts/det/engine-reading.js` | start/end memory and SIGKILL cause logs in `.atris/state/engine-resource.jsonl` plus `atris engine sweep` |
| read-only engine asks and canvas link | `lib/engine-ask.js`, `commands/link.js` | headless ask argv per engine and `atris link "a" "b"` across context or team |
| fleet flights and one-lap dispatch | `lib/fleet.js`, `commands/one-lap.js`, `lib/codex-flight.js`, `lib/one-lap-validator.js`, `lib/conductor-artifacts.js` | parallel engine builds, claim leases, default-branch and no-origin handling, stall handover, and sealed review |
| autopilot, wish intake, and idea loop | `commands/autopilot.js`, `commands/wish.js`, `lib/wish-audit.js`, `commands/idea.js`, `lib/idea-inbox.js`, `lib/idea-tick.js`, `lib/idea-ledger.js`, `lib/idea-gate.js`, `lib/engine-login.js` | one-tick plan/do/review, wish slicing, and `atris idea` inbox, 10-minute timer, sealed login, and outcome ledger |
| worktree command and disk room | `commands/worktree.js`, `lib/worktree-space.js`, `commands/land.js` | isolated checkouts, APFS `node_modules` clones, free-space guards, and `worktree cleanup` / `sweep` |
| team view, member lifecycle, and handoffs | `commands/team.js`, `commands/member.js`, `lib/member-core.js`, `lib/team-lineup.js`, `lib/member-engine.js`, `lib/member-park.js`, `lib/member-task-pick.js`, `lib/member-verbs.js`, `lib/handoff-wake.js` | `atris team`, `member run/wake/sleep`, shared member helpers, task assignment pickup, parked members, and `member handoff` under `lib/yes-lock.js` |
| member supervisor, board, report, and export | `lib/member-up.js`, `lib/member-self-next-job.js`, `lib/member-board.js`, `lib/member-result.js`, `lib/member-report.js`, `lib/member-tidy.js`, `lib/member-export.js`, `lib/member-scaffold.js`, `lib/member-context.js` | `member up` supervisor, live progress board, 24h team report, landed-copy tidy, and `.claude`/`.cursor`/`.codex` subagent export |
| gm front office, phone orb, bet desk, and walk | `commands/gm.js`, `lib/gm-season.js`, `lib/gm-target.js`, `lib/gm-phone.js`, `lib/gm-phone-page.js`, `lib/gm-bet.js`, `lib/gm-card.js`, `lib/yes-lock.js`, `lib/mission-protected-lane.js`, `lib/qr.js`, `scripts/orb-walk.js`, `scripts/gm-phone-layout.js` | playable season board, weekly owner targets, QR-paired phone decision cards, swarm-drafted bets, yes-lock guards, and headless Chrome walk/layout checks |
| scoreboard, scorecard, and Atris Rating | `commands/scoreboard.js`, `commands/scorecard.js`, `lib/repo-scorecard.js`, `commands/rating.js`, `lib/atris-rating.js` | daily contribution scoreboard, git-history model scorecard, and 25-to-99 Atris Rating scale |
| ninety-nine focus and meditation timer | `commands/ninety-nine.js`, `lib/ninety-nine.js`, `lib/ninety-nine-sync.js` | `atris 99` live session timer, daily health totals, and append-only JSONL sync |
| Host member and introductions | `commands/host.js`, `lib/host.js`, `templates/members/host/` | `atris host` introductions, room coverage, draft outbox, and Slack delivery |
| pay, account trust, and google integrations | `commands/pay.js`, `commands/trust.js`, `commands/integrations.js`, `commands/computer.js` | `/api/pay` credits, `/api/trust` vouches, Google account/calendar selection, and cloud computer chat |
| pack publish, install, share, and capabilities | `commands/pack.js`, `lib/pack-core.js`, `lib/pack-capabilities.js`, `commands/pack-craft.js` | pack manifest, packet allowlist, secret scan, registry/share/browse/sales helpers in `lib/pack-core.js`, capability policy in `lib/pack-capabilities.js`, and CLI commands in `commands/pack.js` |
| auth, credentials, API client, and config | `commands/auth.js`, `utils/auth.js`, `utils/api.js`, `utils/config.js`, `utils/backend-root.js`, `utils/owner-identity.js`, `utils/update-check.js`, `commands/pull.js`, `commands/push.js`, `lib/self-drive.js` | local credentials loaded in `utils/auth.js`; token refresh, origin-safe redirects, local HTTP server safety (`lib/site.js`, `lib/secret-gateway.js`), and Swarlo client |
| wiki, design, RSI, and human revision commands | `commands/wiki.js`, `lib/wiki.js`, `commands/design.js`, `lib/design-api.js`, `commands/rsi.js`, `lib/rsi-record.js`, `lib/rsi-loop.js`, `commands/improve.js` | wiki ingest/lint, design extract/check, Dream-RSI ledger and notebook loop, and `atris improve revisions` |
| journals, daily logs, lessons, and receipts | `lib/journal.js`, `lib/daily-log.js`, `lib/lesson-ledger.js`, `lib/receipt-block.js` | daily logs, member/master journal routing, compounding lessons, and proof receipt blocks |
| ax chat app and try-repo server | `ax`, `atris/refs/FEATURE-MAP-ax.md`, `lib/try-repo.js` | Mercury chat CLI (`--mercury`, `--diffuse`, `/model`) and sandboxed public GitHub repo mapper |
| active feature specs | `atris/features/campaign/idea.md`, `atris/features/cloud-sync-simplicity/idea.md`, `atris/features/codex-goal-replacement/idea.md`, `atris/features/company-brain-sync/idea.md`, `atris/features/endstate/idea.md`, `atris/features/plan-review-by-validator/idea.md`, `atris/features/spaceship/idea.md`, `atris/features/verify-falsifiability/idea.md` | active specs in `atris/features/` |
| active team members | `atris/team/alpha-judge/MEMBER.md`, `atris/team/architect/MEMBER.md`, `atris/team/auto-improver/MEMBER.md`, `atris/team/brainstormer/MEMBER.md`, `atris/team/builder/MEMBER.md`, `atris/team/customer-lead/MEMBER.md`, `atris/team/engine-manager/MEMBER.md`, `atris/team/executor/MEMBER.md`, `atris/team/improver/MEMBER.md`, `atris/team/launcher/MEMBER.md`, `atris/team/linguist/MEMBER.md`, `atris/team/mission-lead/MEMBER.md`, `atris/team/navigator/MEMBER.md`, `atris/team/opus-overnight/MEMBER.md`, `atris/team/orb/MEMBER.md`, `atris/team/researcher/MEMBER.md`, `atris/team/scout/MEMBER.md`, `atris/team/task-planner/MEMBER.md`, `atris/team/validator/MEMBER.md`, `atris/team/youtube-lead/MEMBER.md` | one folder per active member under `atris/team/` |
| tests, fixtures, release, and CI | `package.json`, `test/commands-1.test.js`, `test/helpers/commands-fixtures.js`, `scripts/publish-atris-release.js`, `scripts/pre-commit`, `.github/workflows` | `npm test`, `npm run test:fast`, shared `test/helpers/` fixtures, tag-driven publish, and pre-commit gate |
| deep map with line refs | `atris/refs/MAP-NOTES.md` | rg shortcuts and exact `file:line` notes |

## Load order

1. `atris/now.md` then `atris/brain/STATUS.md`, if present (local files made by `atris brain activate`; a fresh checkout has neither)
2. `atris/PERSONA.md` for voice, `atris/atris.md` for protocol
3. `atris/MAP.md` to route work, `atris/TODO.md` for the queue
4. `atris/wiki/index.md` if present (local), and `atris/skills/atris/SKILL.md` as needed
5. Exact lines and search shortcuts: `atris/refs/MAP-NOTES.md`
