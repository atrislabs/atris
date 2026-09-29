# MAP.md: atris-cli navigation

This repo builds the `atris` CLI (Node, zero dependencies). Entry is
`bin/atris.js`; command handlers live in `commands/`, shared helpers in `lib/`,
API and auth in `utils/`, tests in `test/`. Workspace truth lives in `atris/`:
tasks in the task DB rendered to `atris/TODO.md`, protocol in `atris/atris.md`,
members in `atris/team/`, feature specs in `atris/features/`, knowledge in
`atris/wiki/`.

The archived deep map with rg search shortcuts is `atris/refs/MAP-NOTES.md`.

## Routing

| Task | Primary path | Notes |
|------|--------------|-------|
| task database and TODO markdown renderer | `lib/task-db.js` | SQLite tasks, renderTodoMarkdown |
| task command surface | `commands/task.js` | claim, ready, accept, render |
| task list keeper | `lib/task-list-keeper.js` | one lookup; puts away only rows ready to leave |
| cli entrypoint where commands get registered | `bin/atris.js` | dispatch, knownCommands, help |
| known commands list | `lib/known-commands.js` | command name registry |
| brain compile command | `commands/brain.js` | compiles the agent brain |
| engine dispatch runner command | `lib/runner-command.js` | builds runner argv |
| engine profiles defined | `lib/engine-registry.js` | profile-name list |
| engine command | `commands/engine.js` | atris engine |
| wiki command | `commands/wiki.js` | atris wiki, lint |
| wiki ingest library | `lib/wiki.js` | ingest and query helpers |
| Instinct interview and Atris text-product comparison | `atris/wiki/briefs/instinct-personal-agent-2026-09-28.md` | source claims, mechanisms, product proof gap |
| mission root resolver | `lib/mission-root.js` | workspace root helper |
| mission command | `commands/mission.js` | start, tick, complete |
| worktree command | `commands/worktree.js` | isolated checkouts |
| tests | `test/commands.test.js` | node --test test/ |
| run one test | `package.json` | npm test, node --test |
| login and token code | `commands/auth.js` | login, agent tokens |
| stored auth token reader | `utils/auth.js` | token storage |
| swarlo client | `lib/self-drive.js` | hub URL and keys |
| member files | `atris/team` | one folder per member |
| release publish script | `scripts/publish-atris-release.js` | tag-driven publish |
| journal writer | `lib/journal.js` | daily logs |
| autoland gate | `lib/autoland.js` | certified landings |
| autoland command | `commands/autoland.js` | atris autoland |
| slop detector | `commands/slop.js` | prose lint |
| lesson ledger | `lib/lesson-ledger.js` | compounding lessons |
| first minute boot flow | `lib/first-minute.js` | bare atris screen |
| api client | `utils/api.js` | HTTPS calls |
| cli config | `utils/config.js` | local config |
| update check | `utils/update-check.js` | version check |
| task projection file | `.atris/state/tasks.projection.json` | readable task view |
| compiled brain status | `atris/brain/STATUS.md` | brain state |
| self improvement ledger | `atris/brain/self_improvement_ledger.md` | brain ledger |
| workspace protocol spec | `atris/atris.md` | operating protocol |
| persona voice spec | `atris/PERSONA.md` | communication style |
| current focus | `atris/now.md` | what matters now |
| wiki index | `atris/wiki/index.md` | knowledge index |
| atris skill | `atris/skills/atris/SKILL.md` | workspace skill |
| feature spec folder | `atris/features` | one folder per idea |
| member command | `commands/member.js` | member goals |
| member scaffold | `lib/member-scaffold.js` | new member files |
| activate command | `commands/activate.js` | load context |
| context gatherer | `lib/context-gatherer.js` | first-contact gather |
| todo fallback | `lib/todo-fallback.js` | legacy TODO read |
| receipt block builder | `lib/receipt-block.js` | proof receipts |
| doctor health check | `commands/doctor.js` | atris doctor |
| ci workflows | `.github/workflows` | test and publish gates |
| pre-commit hook | `scripts/pre-commit` | local gate |
| stale feature and idle member parking | `scripts/park_stale_features.py` `scripts/park_idle_members.py` | parks 60-day ideas and 30-day-quiet members |
| doc health questions | `atris/doc-health/questions.jsonl` | lookup test set |
| archived map deep dive | `atris/refs/MAP-NOTES.md` | old rg shortcut map |

## Load order

1. `atris/now.md` then `atris/brain/STATUS.md`
2. `atris/PERSONA.md` for voice, `atris/atris.md` for protocol
3. `atris/MAP.md` to route work, `atris/TODO.md` for the queue
4. `atris/wiki/index.md` and `atris/skills/atris/SKILL.md` as needed
5. Deep search shortcuts live in `atris/refs/MAP-NOTES.md`
