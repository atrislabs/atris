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
| plain english to a command | `lib/intents.js` `commands/guide.js` | atris guide; agents translate, users never learn verbs |
| project initialization | `commands/init.js` | init and update scaffold user projects |
| task database and TODO markdown renderer | `lib/task-db.js` | SQLite task store, renderTodoMarkdown |
| task command surface | `commands/task.js` | claim, ready, accept, render, keep, day |
| task list keeper | `lib/task-list-keeper.js` | one lookup; puts away only rows ready to leave |
| task projection file | `commands/task.js` | writes the readable view at .atris/state/tasks.projection.json (local, gitignored) |
| todo fallback | `lib/todo-fallback.js` | legacy TODO read |
| mission command | `commands/mission.js` | start, run, tick, complete, error streaks |
| mission root resolver | `lib/mission-root.js` | workspace root resolved here |
| engine dispatch runner command | `lib/runner-command.js` | builds runner argv, model precedence |
| engine profiles defined | `lib/engine-registry.js` | profile-name list |
| engine command | `commands/engine.js` | atris engine |
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
