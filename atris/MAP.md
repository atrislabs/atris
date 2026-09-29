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
| known commands list | `lib/known-commands.js` | command names and typo suggestions; the plain and JSON unknown-command errors both use suggestCommands |
| Host member install, introductions, and Slack delivery | `templates/members/host/`, `commands/member.js`, `lib/member-scaffold.js`, `commands/host.js`, `lib/host.js` | packaged member copy and `member install host --update` for template skills, group or personal room setup, private records, bulk people and link import, published cards, late replies during timed rest, reply routing by outbox id or provider ref, introduction roster, followups, room coverage, draft outbox, Slack delivery through the shared API client, and daily archival of old sent messages; `test/host.test.js` |
| plain english to a command | `lib/intents.js` `commands/guide.js`, `lib/intents.js:100`, `lib/intents.js:107` | atris guide; agents translate, users never learn verbs; "who does what" goes to `atris engine roster`, "change the builder" to `atris engine assign` and asks first |
| project initialization | `commands/init.js` | init and update scaffold user projects |
| task database and TODO markdown renderer | `lib/task-db.js` | SQLite task store, renderTodoMarkdown |
| where ~/.atris state lives (test fence) | `lib/state-home.js`, `lib/task-db.js:191` | under node --test with the real home, tasks.db and other ~/.atris files go to a throwaway folder; ATRIS_TEST_REAL_HOME=1 opts back in; `test/test-state-fence.test.js` |
| task command surface | `commands/task.js` | claim, ready, accept, render, keep, day |
| task list keeper | `lib/task-list-keeper.js` | one lookup; puts away only rows ready to leave |
| task projection file | `commands/task.js` | writes the readable view at .atris/state/tasks.projection.json (local, gitignored) |
| todo fallback | `lib/todo-fallback.js` | legacy TODO read |
| mission command | `commands/mission.js` | start, run, tick, complete, error streaks |
| mission root resolver | `lib/mission-root.js` | workspace root resolved here |
| engine dispatch runner command | `lib/runner-command.js`, `lib/runner-command.js:331` | builds runner argv, model precedence; each profile says whether it takes a pinned model and which effort words map to its own flag; codex and grok run only their own models, so `runnerModelFor` (`lib/runner-command.js:232`) drops a claude name for them, by profile or by bin name |
| engine profiles defined | `lib/engine-registry.js` | profile-name list |
| engine command | `commands/engine.js` | atris engine |
| roster file and routing | `lib/engine-registry.js:1063`, `lib/engine-registry.js:1191`, `lib/engine-registry.js:947`, `lib/engine-registry.js:1431`, `lib/engine-registry.js:1515`, `lib/engine-registry.js:1626`, `lib/engine-registry.js:1672`, `lib/engine-registry.js:1714` | jobs live in `atris/ROSTER.md` (this project) and `~/.atris/ROSTER.md` (all projects), hand-editable; each `## job` lists its workers in order by tool and model, and the one-line shape still reads; bad lines become warnings; the first assign rewrites a one-line file into sections with the same meaning; this session, then this project, then all projects, each walking its workers in order, then the job's kind, then the router; `resolveJobTeam` returns every worker that can run, lead first |
| roster words, job names, dates, effort, and caps | `lib/engine-registry.js:681`, `lib/engine-registry.js:716`, `lib/engine-registry.js:765`, `lib/engine-registry.js:868`, `lib/engine-registry.js:314`, `lib/engine-registry.js:614`, `lib/engine-registry.js:646`, `lib/engine-registry.js:457` | tool, model, and effort words to one worker; `claude code`, `atris fast`, and `gemini` name tools; `model:`, `effort:`, `max: 20 min`, and `until` parts; names that only look like a built-in job are refused; `until` needs a year, and a year-less date is a warning that counts as expired |
| roster text edits | `lib/roster-markdown.js:42`, `lib/roster-markdown.js:116`, `lib/roster-markdown.js:131`, `lib/engine-registry.js:1272`, `lib/engine-registry.js:1344`, `lib/engine-registry.js:1212` | which lines are one-line jobs, workers under a `## job`, or team; one job's section edited while comments, notes, and order stay; old-shape conversion; lead, `--add`, `--remove`, `--backup`, `--promote`, `--clear` |
| team members pick engines | `lib/member-engine.js:91`, `lib/member-engine.js:135`, `lib/member-engine.js:203`, `lib/member-engine.js:40`, `commands/mission.js:405`, `commands/member.js:880`, `commands/autopilot.js:510` | search, review, or build from name or role, `## team` overrides; a worktree reads a card from the main checkout like the roster; owned missions, `member run`, and autopilot phases use the pick; `--engine` still wins |
| team view and boot lineup | `commands/team.js:571`, `commands/team.js:296`, `lib/team-lineup.js:38`, `lib/team-lineup.js:57`, `lib/team-lineup.js:137`, `lib/team-lineup.js:149`, `bin/atris.js:1857` | `atris team` prints who does each job and who is on each job (tool and model) before the active and rest lists, `--json` adds a lineup per member; the session boot gets one `team` line with the lead per built-in job; all read through `rosterReport` and `jobRosterView`, and a roster that cannot be read costs one line or drops the boot line |
| parked team members | `lib/member-park.js:29`, `lib/member-park.js:38`, `lib/member-park.js:60`, `commands/team.js:239`, `commands/team.js:544`, `lib/member-engine.js:217`, `lib/functional-owner.js:93`, `commands/member.js:1085` | `status: parked` plus a dated `parked_note` in MEMBER.md frontmatter; `atris team park <name> [--note]` and `atris team unpark <name>` write only those two lines; `atris team` folds parked members into one `parked (N)` line (`--all` lists them in place, `--json` says `parked`), the roster team block and boot lineup skip them, owner inference never picks them; runs, missions, runtime aliases, and saved state ignore parking, and `member run` on a parked member prints one notice and runs; `test/team-park.test.js` |
| roster commands and view | `commands/engine.js:1019`, `commands/engine.js:1081`, `commands/engine.js:1100`, `commands/engine.js:1125`, `commands/engine.js:1237`, `commands/engine.js:1210`, `commands/engine.js:1188`, `commands/engine.js:1263`, `commands/engine.js:1477`, `lib/roster-models.js:66`, `lib/roster-models.js:32`, `lib/roster-models.js:161` | every worker shows the real model, effort, and where they came from; a job with more than two workers lists them all with who leads and why others are skipped; team block, warnings, confirm, `roster session [clear]`, `roster --available` (codex models from `~/.codex/models_cache.json`, others from known names), assign, and `resolve <job>` |
| roster run record | `lib/roster-runs.js:190`, `lib/roster-runs.js:162`, `lib/roster-runs.js:258`, `lib/roster-runs.js:37`, `lib/fleet.js:800`, `lib/fleet.js:823`, `lib/fleet.js:852`, `lib/fleet.js:1089`, `lib/fleet.js:2505`, `commands/mission.js:499`, `commands/autopilot.js:546`, `lib/engine-ask.js:571`, `lib/self-drive.js:295`, `commands/engine.js:1264`, `commands/engine.js:1282` | one line per roster run in `.atris/state/roster_runs.jsonl` (job, member, engine, model, effort, cap, seconds, landed / failed / stalled / credit out, who took over, tokens only when printed, prep and brief size); past 2 MB the log renames aside to a unique stamped name before the append instead of trimming, so no record is cut, two writers can never overwrite each other's history, and a raced append still lands in a file readers read (`lib/roster-runs.js:162`); readers take the newest rotated files then the live one (`lib/roster-runs.js:258`) and coerce every field to its type (`lib/roster-runs.js:239`); a run recorded or read from inside a git worktree uses the main checkout's file, so reaping the worktree never drops history (`lib/roster-runs.js:37`); fleet, `engine dispatch`, one-lap build and review, mission ticks, autopilot phases, `engine ask` (job `ask`, source `ask`), and a mission blocker's build (source `mission blocker`, which also writes engine health so a stall benches it) write it; a fleet claude run launches with `--output-format json` so its line carries tokens and cost while the report stays claude's final text (a custom runner template or renamed binary keeps the plain launch and records no tokens); `engine roster` shows each worker's last 7 days and `--runs [job]` the last 20; not covered yet: cursor, devin, grok, agy, and opencode fleet runs print no usage so their lines have no tokens, and a blocker build that stalls does not hand over to the next build worker |
| heavy worker prep brief | `lib/roster-prep.js:244`, `lib/roster-prep.js:263`, `lib/roster-prep.js:165`, `lib/roster-prep.js:55`, `lib/roster-prep.js:107`, `lib/roster-prep.js:121`, `lib/engine-registry.js:904`, `lib/engine-registry.js:965`, `lib/engine-registry.js:1542`, `lib/fleet.js:891`, `lib/fleet.js:944`, `lib/fleet.js:1056`, `lib/fleet.js:2567`, `lib/fleet.js:2954`, `commands/engine.js:2027`, `commands/one-lap.js:240`, `commands/mission.js:404`, `commands/autopilot.js:615` | a worker line with `prep: search` (or `assign --prep search`) has that job's lead read the task read-only first and write a brief capped at 300 lines and 20 KB; the heavy worker gets its prompt plus the brief; prep stops at the prep worker's own max, else 5 minutes, and on a stall, failure, or empty answer the worker runs as before with `prep skipped: <reason>` on its record; the prep pass writes its own run line; a job naming itself is a warning; fleet builds, `engine dispatch`, one-lap build and review, handover backups, roster-picked mission ticks, and autopilot phases honor it (autopilot runs the same pass synchronously, `runPrepPassSync`); the prep ask carries the prep worker's own effort; not covered yet: `engine ask`, a mission blocker's build, and ticks on a named runner or `atris2`; `test/roster-prep-brief.test.js`, `test/roster-coverage-gaps.test.js` |
| roster suggestions | `lib/roster-suggest.js:70`, `lib/roster-suggest.js:112`, `lib/roster-suggest.js:126`, `commands/engine.js:1264`, `lib/team-lineup.js:57`, `lib/router-brain.js:216` | `engine roster` shows at most one suggestion per job when the last 7 days say the order is wrong: the lead has 3+ recent runs and lands under 50%, and a ready worker lower down has 2+ runs and lands at least 25 points more often (newest 5 runs each, credit out left out); the line names an `assign --promote` command that moves the worker's line up as written, and `--json` carries it as `suggestion`; the boot team line adds `· 1 suggestion (atris engine roster)` from the last 64 KB of the record; the router counts roster runs as receipts for jobs with no roster line (landed passes, stalled and failed miss, a receipt and its run record count once by task id); nothing writes ROSTER.md; `test/roster-suggestions.test.js` |
| roster model, effort, and cap reach runs | `lib/engine-registry.js:1745`, `lib/engine-registry.js:1593`, `commands/mission.js:398`, `commands/one-lap.js:219`, `lib/fleet.js:783`, `lib/fleet.js:226`, `commands/autopilot.js:510`, `commands/autopilot.js:1420`, `lib/engine-ask.js:69`, `lib/engine-ask.js:226` | a backup runs its own model and effort; missions, one-lap builds and reviews, engine dispatch, fleet spawns, autopilot phases, and plan review get the pin; `engine ask` with no `--model` takes the `## ask` job's model and effort when that engine is a live worker on that line, else the engine's own default (effort as the runners' own flag, dropped for an engine that takes none); the cap stops the run (codex watchdog `--max-runtime`, dispatch backstop, tick and phase timeouts) |
| stalled worker handover | `lib/engine-registry.js:68`, `lib/engine-registry.js:1923`, `lib/engine-registry.js:1959`, `lib/engine-registry.js:50`, `lib/fleet.js:852`, `commands/mission.js:451`, `commands/autopilot.js:576` | a time cap, watchdog exit, or dropped connection benches the engine as cooling for 30 minutes (`ATRIS_ENGINE_COOLDOWN_MINUTES`), every resolver skips it until then, and it comes back on its own; a stalled dispatch walks the build team once per worker with each worker's own pins; mission ticks and autopilot phases rely on the bench; `test/stall-handover.test.js` |
| small build pick | `lib/engine-registry.js:1649`, `lib/wish-audit.js:436` | a low-stakes build or the job option checks the "small build" pick first; quick wishes ask for it |
| read-only engine asks | `lib/engine-ask.js` | per-engine headless ask argv |
| fleet flights | `lib/fleet.js` | parallel engine builds, ship gate, landed proof handoff |
| autopilot | `commands/autopilot.js` | one tick plan, do, review |
| wish intake | `commands/wish.js` | wish to build slices |
| worktree command | `commands/worktree.js` | isolated checkouts |
| brain compile command | `commands/brain.js` | brain artifacts compiled here |
| activate command | `commands/activate.js` | load context |
| context gatherer | `lib/context-gatherer.js` | first-contact gather |
| first minute boot flow | `lib/first-minute.js` | bare atris screen |
| document health | `commands/doc-health.js` `lib/map-refs.js` | document health measurements: boot size, map coverage, lookup hops, freshness, map line refs |
| doc health questions | `atris/doc-health/questions.jsonl` | lookup test set, ten questions |
| doctor health check | `commands/doctor.js` | workspace readiness checked by doctor |
| wiki command | `commands/wiki.js` | atris wiki, lint |
| wiki ingest library | `lib/wiki.js` | ingest and query helpers |
| login and token code | `commands/auth.js` | login, agent tokens |
| stored auth token reader | `utils/auth.js` | local credentials loaded and stored |
| api client | `utils/api.js` | HTTPS calls |
| cli config | `utils/config.js` | local config |
| backend root and owner identity | `utils/backend-root.js` `utils/owner-identity.js` | portable local roots, no laptop paths |
| update check | `utils/update-check.js` | version check |
| swarlo client | `lib/self-drive.js` | hub URL and keys |
| member command | `commands/member.js` | member goals, alive loop |
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
