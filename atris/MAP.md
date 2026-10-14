# MAP.md: atris-cli navigation

This repo builds the `atris` CLI (Node, zero dependencies). Entry is
`bin/atris.js`; command handlers live in `commands/`, shared helpers in `lib/`,
API and auth in `utils/`, tests in `test/`. Workspace truth lives in `atris/`:
tasks in the task DB rendered to `atris/TODO.md`, protocol in `atris/atris.md`,
members in `atris/team/`, feature specs in `atris/features/`.

File:line refs and rg search shortcuts live in `atris/refs/MAP-NOTES.md`. Open it
when this table names the file but you need the exact line. Rows ending in
"detail in MAP-NOTES" keep their full description and line refs under
"Routing detail" there. `atris doc-health`
checks the refs in both files; `atris doc-health --fix-refs` moves drifted ones.

## Routing

| Task | Primary path | Notes |
|------|--------------|-------|
| cli entrypoint and command router | `bin/atris.js` | dispatch chain, knownCommands, help |
| known commands list | `lib/known-commands.js` | command names and typo suggestions; the plain and JSON unknown-command errors both use suggestCommands |
| Host member install, introductions, and Slack delivery | `templates/members/host/`, `commands/member.js`, `lib/member-scaffold.js`, `commands/host.js`, `lib/host.js` | packaged member copy and `member install host --update` for template skills, group or personal room setup, private records; detail in MAP-NOTES |
| plain english to a command | `lib/intents.js` `commands/guide.js`, `lib/intents.js:100`, `lib/intents.js:107` | atris guide; detail in MAP-NOTES |
| project initialization | `commands/init.js`, `commands/sync.js`, `lib/gitignore.js` | init and update scaffold user projects; both pin `atris/runs/` + `atris/status/` in the project .gitignore (git repos only, append-only) |
| task database and TODO markdown renderer | `lib/task-db.js` | SQLite task store, renderTodoMarkdown |
| where ~/.atris state lives (test fence) | `lib/state-home.js`, `lib/task-db.js:191` | under node --test with the real home, tasks.db and other ~/.atris files go to a throwaway folder; detail in MAP-NOTES |
| task command surface | `commands/task.js` | claim, ready, accept, render, keep, day |
| task list keeper | `lib/task-list-keeper.js` | one lookup; puts away only rows ready to leave |
| idle waiting work resolves itself | `lib/idle-review-sweep.js`, `commands/autoland.js` (step 3c2 of the tick) | hourly: review rows idle past `idle_close_days` (default 7) whose check can never run from main close with a plain reason; detail in MAP-NOTES |
| trust tiers (earned autonomy) | `lib/trust-tiers.js` | keyed by the builder (`built_by`, else claimed_by), recovered for old history rows through `task_episodes.jsonl`; detail in MAP-NOTES |
| agent-copy checks rerun from main | `lib/verify-worktree-rewrite.js`, `resolveTaskVerify` in `lib/auto-accept-certified.js` | a check recorded in `.agent-worktrees/<project>/<name>` is rewritten relative to the main checkout; detail in MAP-NOTES |
| boot cleanup line | `lib/cleanup-summary.js`, `bin/atris.js` (`lately` row) | newest plain line from the journal's `## <project> overnight` section plus parked branches; the autoland tick writes its own line there |
| test junk cleanup in the task database | `commands/task.js`, `lib/task-prune.js` | `atris task prune-test-junk` counts rows whose project folder sits under a temp directory and is gone from disk; detail in MAP-NOTES |
| task projection file | `commands/task.js` | writes the readable view at .atris/state/tasks.projection.json (local, gitignored) |
| todo fallback | `lib/todo-fallback.js` | legacy TODO read |
| mission command | `commands/mission.js` | start, run, tick, complete, error streaks |
| mission root resolver | `lib/mission-root.js` | workspace root resolved here |
| engine dispatch runner command | `lib/runner-command.js`, `lib/runner-command.js:331` | builds runner argv, model precedence; detail in MAP-NOTES |
| engine profiles defined | `lib/engine-registry.js` | profile-name list |
| engine command | `commands/engine.js` | atris engine |
| pushing scoreboard | `commands/scoreboard.js`, `bin/atris.js` | `atris scoreboard [--watch] [--json]`: today's github contributions, bar toward best day this year, streak, this repo's commits split you vs members; detail in MAP-NOTES |
| link two things (canvas verb) | `commands/link.js`, `bin/atris.js` | `atris link "a" "b" [--context] [--team] [--json]` asks the roster's `link` job, else the `build` lead, through the engine ask runner; detail in MAP-NOTES |
| roster file and routing | `lib/engine-registry.js` | jobs live in `atris/ROSTER.md` (this project) and `~/.atris/ROSTER.md` (all projects), hand-editable; detail in MAP-NOTES |
| roster words, job names, dates, effort, and caps | `lib/engine-registry.js` | tool, model, and effort words to one worker; detail in MAP-NOTES |
| roster text edits | `lib/roster-markdown.js`, `lib/engine-registry.js` | which lines are one-line jobs, workers under a `## job`, or team; detail in MAP-NOTES |
| ideas pick team members by job | `commands/member.js`, `lib/member-engine.js` | dispatch uses the roster's build, review, or search job for renamed members; detail in MAP-NOTES |
| team members pick engines | `lib/member-engine.js`, `commands/mission.js`, `commands/member.js`, `commands/autopilot.js` | search, review, or build from name or role, `## team` overrides; detail in MAP-NOTES |
| team view and boot lineup | `commands/team.js`, `lib/team-lineup.js`, `lib/engine-processes.js`, `bin/atris.js` | `atris team` prints one table row per member (job, engine and model, status, what it is doing), working-now first; detail in MAP-NOTES |
| parked team members | `lib/member-park.js`, `commands/team.js`, `lib/member-engine.js`, `lib/functional-owner.js`, `commands/member.js` | `status: parked` plus a dated `parked_note` in MEMBER.md frontmatter; detail in MAP-NOTES |
| roster commands and view | `commands/engine.js`, `lib/roster-models.js` | every worker shows the real model, effort, and where they came from; detail in MAP-NOTES |
| notes job (who writes YouTube notes) | `lib/engine-registry.js`, `commands/engine.js` | `atris engine resolve notes [--json]` always answers with exit 0: the notes roster pick (same layers, order, and skips as every job); detail in MAP-NOTES |
| roster run record | `lib/roster-runs.js`, `lib/fleet.js`, `commands/mission.js`, `commands/autopilot.js`, `lib/engine-ask.js`, `lib/self-drive.js`, `commands/engine.js` | one line per roster run in `.atris/state/roster_runs.jsonl`; detail in MAP-NOTES |
| heavy worker prep brief | `lib/roster-prep.js`, `lib/engine-registry.js`, `lib/fleet.js`, `commands/engine.js`, `commands/one-lap.js`, `commands/mission.js`, `commands/autopilot.js` | a worker line with `prep: search` (or `assign --prep search`) has that job's lead read the task read-only first and write a brief capped at 300 lines; detail in MAP-NOTES |
| roster suggestions | `lib/roster-suggest.js`, `commands/engine.js`, `lib/team-lineup.js`, `lib/router-brain.js` | `engine roster` shows at most one suggestion per job when the last 7 days say the order is wrong: the lead has 3+ recent runs and lands under 50%; detail in MAP-NOTES |
| roster model, effort, and cap reach runs | `lib/engine-registry.js`, `commands/mission.js`, `commands/one-lap.js`, `lib/fleet.js`, `commands/autopilot.js`, `lib/engine-ask.js` | a backup runs its own model and effort; detail in MAP-NOTES |
| stalled worker handover | `lib/engine-registry.js`, `lib/fleet.js`, `commands/mission.js`, `commands/autopilot.js` | a time cap, watchdog exit, or dropped connection benches the engine as cooling for 30 minutes (`ATRIS_ENGINE_COOLDOWN_MINUTES`); detail in MAP-NOTES |
| small build pick | `lib/engine-registry.js:1649`, `lib/wish-audit.js:436` | a low-stakes build or the job option checks the "small build" pick first; quick wishes ask for it |
| read-only engine asks | `lib/engine-ask.js` | per-engine headless ask argv |
| fleet flights | `lib/fleet.js`, `lib/conductor-artifacts.js`, `test/fleet-landing-dirt.test.js` | parallel engine builds, wait for engine closure, reject source dirt while ignoring untracked run receipts, ship gate, landed proof handoff |
| engine default branch and refusal handling | `lib/fleet.js`, `commands/worktree.js`, `commands/land.js`, `lib/codex-flight.js`, `lib/one-lap-validator.js`, `test/engine-dispatch-mainline.test.js`, `test/one-lap-runtime.test.js` | preserve custom SSH commands, bound shared fetch/push/lookup processes, fetch missing live default refs or stop; detail in MAP-NOTES |
| engine dispatch without origin | `lib/fleet.js`, `test/engine-dispatch-no-origin.test.js` | pin local HEAD when origin is absent, verify and stop ready with a local merge command; origin and sealed review paths retain their gates |
| dispatch run history from a linked checkout | `test/roster-runs-worktree.test.js` | remote-landing test creates a local bare origin so it keeps asserting landed and records history in the main checkout |
| autopilot | `commands/autopilot.js` | one tick plan, do, review |
| wish intake | `commands/wish.js` | wish to build slices |
| worktree command | `commands/worktree.js`, `test/worktree-start-retry.test.js` | isolated checkouts, bounded config-lock retries and cleanup of failed starts |
| brain compile command | `commands/brain.js` | brain artifacts compiled here |
| activate command | `commands/activate.js` | load context |
| context gatherer | `lib/context-gatherer.js` | first-contact gather |
| first minute boot flow | `lib/first-minute.js` | bare atris screen |
| atris done command | `commands/done.js` | land what a coding agent built: check, accept, sign |
| document health | `commands/doc-health.js` `lib/map-refs.js` | document health measurements: boot size, map coverage, lookup hops, freshness, map line refs |
| doc health questions | `atris/doc-health/questions.jsonl` | lookup test set, ten questions |
| doctor health check | `commands/doctor.js` | workspace readiness checked by doctor |
| wiki command | `commands/wiki.js` | atris wiki, lint |
| wiki ingest library | `lib/wiki.js` | ingest and query helpers |
| login and token code | `commands/auth.js` | login, agent tokens |
| stored auth token reader | `utils/auth.js` | local credentials loaded and stored |
| api client | `utils/api.js` | HTTPS calls |
| cli config | `utils/config.js` | local config |
| backend root and owner identity | `utils/backend-root.js` `utils/owner-identity.js` | portable local roots; installed CLI sibling fenced under node tests, ATRIS_BACKEND_INSTALL_SIBLING=1 opts in and 0 disables the probe |
| update check | `utils/update-check.js` | version check |
| swarlo client | `lib/self-drive.js` | hub URL and keys |
| member command | `commands/member.js` | member goals, alive loop |
| keep the team working (member up) | `lib/member-up.js` | task-only supervisor with runnable checks, live progress through `followBoard` in `lib/member-board.js`, and checked finish results; detail in MAP-NOTES |
| plain member verbs (run "<job>", wake N, wake a b) | `lib/member-verbs.js` | routes to dispatch, member up, or the old run and wake |
| member result (newest run, read back) | `lib/member-result.js`, `commands/member.js` | `atris member result <member> [--since] [--json]`: run line from the roster run record, newest logs/ receipt and work/ files after the run started; detail in MAP-NOTES |
| member tidy (put away landed copies) | `lib/member-tidy.js:101`, `lib/member-tidy.js:81`, `commands/member.js:11038` | `atris member tidy [--dry-run] [--dir <path>]`: fetches origin, keeps copies whose branch is not in origin's default branch (listed with age); detail in MAP-NOTES |
| member board (who is working right now) | `lib/member-board.js`, `commands/member.js` | `atris member board [--watch] [--json] [--all] [--follow]`: one row per progress log in `~/.atris/progress` or `ATRIS_PROGRESS_DIR` with job; detail in MAP-NOTES |
| member export (subagents for coding tools) | `lib/member-export.js`, `commands/member.js`, `commands/sync.js` | `atris member export [--dry-run] [--json]`: each active MEMBER.md becomes `.claude/agents/<name>.md`, `.cursor/agents/<name>.md`; detail in MAP-NOTES |
| member update for developers | `atris/briefs/members-update-2026-10-13.md` | the three member words (run, wake, sleep) with one command each, how to watch members work, the older aliases, and the release they need |
| member scaffold | `lib/member-scaffold.js` | new member files |
| member process context | `lib/member-context.js` | reads MEMBER_PROCESS.md from the executing workspace only |
| member files | `atris/team` | one folder per member |
| feature spec folder | `atris/features` | one folder per idea |
| journal writer | `lib/journal.js` | daily logs |
| member and master logs | `lib/daily-log.js` | detail to member logs, consequential lines to the journal |
| lesson ledger | `lib/lesson-ledger.js` | compounding lessons |
| receipt block builder | `lib/receipt-block.js` | proof receipts |
| autoland gate | `lib/autoland.js` | certified landings |
| autoland command | `commands/autoland.js` | atris autoland |
| slop detector | `commands/slop.js` | prose lint |
| design system commands | `commands/design.js` `lib/design-api.js` | atris design extract and check; shared with atris mcp |
| improvement attempt ledger | `commands/rsi.js` `lib/rsi-record.js` | read and record Dream-RSI attempts |
| workspace tree hash | `commands/tree.js` `lib/tree-hash.js` | atris tree hash over the doctrine files |
| tests | `test/commands.test.js` | node --test test/ |
| run one test | `package.json` | npm test, node --test |
| release publish script | `scripts/publish-atris-release.js` | tag-driven publish |
| ci workflows | `.github/workflows` | test and publish gates |
| pre-commit hook | `scripts/pre-commit` | local gate |
| workspace protocol spec | `atris/atris.md` | operating protocol |
| persona voice spec | `atris/PERSONA.md` | communication style |
| atris skill | `atris/skills/atris/SKILL.md` | workspace skill |
| ax chat app screens | `atris/refs/FEATURE-MAP-ax.md` | drive the running ax app, not the code |
| deep map with line refs | `atris/refs/MAP-NOTES.md` | rg shortcuts and file:line notes |

## Load order

1. `atris/now.md` then `atris/brain/STATUS.md`, if present (local files made by `atris brain activate`; a fresh checkout has neither)
2. `atris/PERSONA.md` for voice, `atris/atris.md` for protocol
3. `atris/MAP.md` to route work, `atris/TODO.md` for the queue
4. `atris/wiki/index.md` if present (local), and `atris/skills/atris/SKILL.md` as needed
5. Exact lines and search shortcuts: `atris/refs/MAP-NOTES.md`
