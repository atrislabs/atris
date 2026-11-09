# Journals and briefs

Daily logs, status, launchpad, analytics, briefs, recaps and visualize. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Modular commands

```bash
rg "logAtris|logsDigest|addInboxIdea|--repl|inbox_capture|speakFirstMinute" commands/log.js lib/first-minute.js bin/atris.js test/log-inbox.test.js test/first-minute.test.js test/logs-digest.test.js test/dogfood-papercuts.test.js test/dogfood-p0.test.js  # `atris log \"note\"` local inbox write after init, empty-folder first-minute refuse (same two spoken lines as bare atris, no atris/logs), one-word notes included, --json capture or first-minute refuse, optional --repl editor, and read-only daily digest
rg "ensureNowFile|nowJsonPayload|nowAtris|renderDefaultNow|renderPortfolioNow|formatLocalTimestamp|currentMissionMoveLine|compactCommitSubject|missionFullBudgetRemainingSeconds|missionBudgetContinuationText|missionHumanStatusText|compactMissionCommand|countOpenWorkItems|countOpenTodoItems|countJournalCompletedReceipts|todayTaskReceiptLines|storeTaskReceipt|now --help|now --json|speakFirstMinute|speakKeepWorkingMinute" bin/atris.js commands/now.js commands/mission.js lib/first-minute.js test/now.test.js test/now-json.test.js test/first-minute.test.js test/dogfood-p0-safety.test.js test/mission-status.test.js test/commands-1.test.js  # now.md and mission status front doors: workspace and portfolio pages name their local refresh minute; spoken `atris now` in a fresh folder reuses first-minute (empty talks first-talk, a file already here names that file and next is `atris do`, no mint, no init); after do mints that file folder with no live mission, spoken now talks keep-working (`already yours` / `next: atris task ready <id> --verify "git diff --check"`), not factory MAP.md; after init --yes --minimal with no live mission, spoken now talks the claim plus one next, same as bare atris / now --json, not factory now.md; `--init` / `--refresh` / `--all` / `--path` still write now.md; a selected full-budget mission names remaining time inside the original commitment instead of sounding like a restart; the short away recap routes task results through the digest and mission proof through mission status, and closes long commit subjects without ellipsis; `atris now --json` is `{ ok, next or current }` with no ANSI and no markdown dump
```

## By-Feature Map

- **atris brief:** `commands/brief.js` prints one screen for the owner: Needs you (finished work with a pull request to merge, including work whose proof could not be saved, jobs sent back from review twice, protected jobs a builder let go of, and the older waiting list), Done this week (one line per landing, with the builder who held the job for it and a pull request or commit link), and Team (rating, arrow against the same rating a week ago, landed, best lane, top miss). `lib/owner-brief.js` reads the task store read only and takes landings, ratings, and miss reasons from `lib/gm-season.js`, so it agrees with `atris rating`; the rating a week ago comes from `outcomesAsOf` there, which uses only the events up to that day and never the job's current holder, and finished work whose proof could not be saved is found by `openReleasePlays` there straight from the store, however long ago it was left (a release older than the job's latest claim, archive, or reopen does not count, since the job was closed and opened again for new work, and the same holds for a refused job's release). Jobs the build machine could not start never reach Needs you, by any path. A pull request is linked only when its link or its repository is saved, a bare number is printed and never guessed into a link, each landing's link comes only from that landing's own history entry, every printed link loses any query string, fragment, or login and is dropped when the redactor would still change it, and titles, notes, reasons, builder names, and tags pass through a redactor built from `lib/security-scan.js` and `utils/agent-client.js` that also hides the value after a sensitive name: always for token, secret, password, api key and their spellings, and for auth, key, session, sig, and signature whenever the value is written as a setting (name=value or json) or looks like a token (a digit, or 16 or more characters with no space), so a title like "Fix auth: redirect loop" reads as written. Known provider keys are hidden after any character (worker_ghp_... too), a quoted value is read to its closing quote with backslash escapes (a quote that never closes runs to the end of the text, and any other value runs to the next space, so `password=abc,def` hides all of it, and so does `password=ghp_...,def`, since a key an earlier pattern already hid is part of the run, marker included), the redactor reads only the first 5000 characters of a field, cut back to the last space so no token is split (a field with no space in that stretch shows nothing), and keeps at most 300 characters of that, again up to the last whole word (`scrubbed` in `lib/owner-brief.js`, since `scrub` alone cuts wherever the 300th falls), so a word that would reach past 300 is dropped whole with everything after it and a link or a path at the cap is never left as a piece, a release reason or note that is as long as the store's 300-character cut (`RELEASE_REASON_MAX` in `lib/task-db.js`, and the flights' own 300 cut) is read without its last word, since a key across that cut is a piece no pattern can know (`reasonOf`, used for the top miss, a refused job's reason, and a send-back note), and the last word of any title, note, reason, builder name, or tag is hidden from the start of a known key on (`ghp_`, `sk-`, `AKIA`, `eyJ` and the rest of the provider starts, whatever the length of the word or the field), since a flight cuts a reason at 300 before the store squeezes its spaces, so a cut key can sit in a reason of any length (`withoutCutKey`; a link or a path is left alone, so a title ending in a pull request link or a branch like `feature/sk-tools` keeps its name: a start right after a slash does not count, and in a link only the starts that count after any character, and a Slack webhook address, are read in front of its path; a whole key is still hidden there by the key patterns), and its patterns stay linear so a megabyte of hostile text cleans in milliseconds, and the older proof field never shows a piece of a link that could not be printed. A title is shortened only where a person reads it (the text, the page, and the text `--send` sends; `withShortTitles` and `operatorTitle` in `commands/brief.js`): plumbing such as a task code, a file name, or a shell command is left out, a link or a path with a slash in it (a pull request link, `feature/ABC-123`) is kept whole or dropped whole and never cut in two, so a title never ends in `feature/` or in a scheme with no address, and a title that is only one link too long to show reads `untitled`; the `--json` fields carry each title as the redactor leaves it (at most 300 characters, ending at a whole word) and not shortened to the line. `--json` keeps the `landed`, `waiting`, `moves`, `week` keys and adds `needs_you`, `done_this_week`, `team`. Coverage in `test/brief.test.js` and `test/brief-owner.test.js`.

## Feature: Daily Logging (`atris log`)

**Purpose:** Add ideas to inbox in today's journal without a live business

- **Entry point:** `commands/log.js:72` (logAtris), router `bin/atris.js` `command === 'log'`
- **Creates:** `atris/logs/YYYY/YYYY-MM-DD.md` files after the room exists
- **Logic:**
- Empty folder: `lib/first-minute.js` `isFreshWorkspace` + `speakFirstMinute` (same two spoken lines and `--json` next as bare `atris`). No `atris/` and no journal write
- After `init --minimal`, `atris log "note"` and one-word `atris log text` append to `## Inbox` locally
- After init, `--json` emits `{ ok, action: inbox_capture, id, note, journal, next_command }`; empty-folder `--json` is `freshMinuteJson`
- One slug-like word is never a live business lookup
- Optional `--repl` editor; headless never opens a prompt
- `--help` stays usage and does not mutate
- Type "exit" to quit the REPL
- **Value:** First-minute capture works in a workspace with no business slug; an empty folder talks like bare `atris`

**Search:** `rg "logAtris|inbox_capture|speakFirstMinute" commands/log.js lib/first-minute.js test/log-inbox.test.js test/first-minute.test.js`

## Feature: System Status (`atris status`)

**Purpose:** Quick visibility into system state - supports parallel work

- **Entry point:** `commands/status.js` (`statusAtris` function)
- **Empty folder:** `isFreshWorkspace` + `speakNothingRunning` (same first-talk as empty-folder `atris stop`: `nothing is running`, talk next, no mint, no init). `--quick` / `--json` / `--verbose` keep that voice. Help stays usage.
- **File folder, no room:** `speakNothingRunning` names the file or last commit like bare `atris` (`notes.txt is already here` / `next: atris do`). No mint.
- **File folder, just minted, no live mission:** `speakKeepWorkingMinute` when first-minute next is claimed keep-working (`"notes.md" is already yours` / `next: atris task ready <id> --verify "git diff --check"`). Not factory `let it run`. Bare `atris stop` reuses that same pair. A live running mission (`pickLiveLocalMission`) still gets the board. `--verbose` keeps the factory dump.
- **After init, next is claim, no live mission:** `speakFirstMinute` when first-minute next is `atris task claim` (same two lines as bare `atris` / `now`). Not factory `let it run`. `--json` keeps the factory board for scripts. `--verbose` keeps the factory dump. A live running mission still gets the board.
- **Help:** `bin/atris.js` (`showStatusHelp`) short-circuits `status --help` before workspace or business-status reads
- **Regression:** `test/first-minute.test.js` (`atris status in an empty folder talks first-talk, not init`; `atris now in an empty folder talks first-talk, not init`; `atris now in a folder with a file names the file, not init`; `atris now after init --yes --minimal talks the claim, not factory now.md`; `atris status after init --yes --minimal talks the claim, not factory let-it-run`; `atris status after minting a file folder talks keep-working, not factory let-it-run`; `atris stop after minting a file folder talks keep-working, not cloud-computer`; `atris stop after init --yes --minimal talks the claim, not cloud-computer`; `atris stop after init and claim talks keep-working, not cloud-computer`); `test/dogfood-p0-safety.test.js` (`26c`, `26d`, `26e`, `26f`, `26g`, `26h`, `26j`, `26k`, `26l`); `test/now-json.test.js`; `test/commands-1.test.js` covers `status --help` without `atris/` or `$HOME/.atris`
- **Signature:** `statusAtris(isQuick = false, jsonMode = false, verbose = false)`
- **Reads:**
- TODO.md Backlog (unclaimed tasks)
- TODO.md In Progress (claimed tasks with ownership)
- Today's journal Inbox (pending ideas, first 3)
- Today's journal Completed (recent completions, last 3)
- **Output:**
- Empty folder: first-talk (`nothing is running` / `next: atris "what do you want here?"`)
- File folder, no room: same two spoken lines as bare `atris` (`notes.txt is already here` / `next: atris do`)
- File folder after mint, no live mission: same two spoken lines as keep-working (`"notes.md" is already yours` / `next: atris task ready <id> --verify "git diff --check"`)
- After init, next is claim, no live mission: same two spoken lines as bare `atris` / `now` (`ready to claim` / `next: atris task claim`)
- Default: Chief-of-staff summary (`Where we are` / `What is queued` / `What is blocking`) when a live mission is running or first-minute next is not keep-working or `atris task claim`
- `--verbose` / `-v`: Legacy visual task board
- `--quick` / `-q`: One-line emoji summary, or the keep-working / claim two lines when nothing is running
- `--json`: Structured JSON (date, backlog, inProgress, completed, inbox, completions, lessons, team); empty-folder `--json` is first-talk refuse; post-mint keep-working `--json` is one-lap (`already yours` / `atris task ready <id> --verify "git diff --check"`); post-init claim `--json` stays the factory board
- **Routing:** `bin/atris.js` (`statusCmd` local path) routes slug status to `commands/context-sync.js` (`businessStatus`)
- **Value:** Parallel work visibility + machine-readable output for scripting

**Search:** `rg "statusAtris|showStatusHelp|speakNothingRunning|speakKeepWorkingMinute|isKeepWorkingMinute|isClaimMinute|status and analytics --help" bin/atris.js commands/status.js lib/first-minute.js test/commands-1.test.js test/first-minute.test.js test/dogfood-p0-safety.test.js`

## Feature: Launchpad (`atris launchpad`)

**Purpose:** One compact command-center card: the single next action plus 3 suggested moves, synthesized from local task, mission, brain, and proof state. Empty and file folders reuse first-minute talk.

- **Entry point:** `commands/launchpad.js:618` (`launchpadCommand`) routes `--help`/`--json`/plain card; empty and file folders reuse `speakFirstMinute` (same two spoken lines as bare `atris`, no mint, no init); post-mint keep-working reuses `speakKeepWorkingMinute`; post-init claim reuses `speakFirstMinute` like `status`/`now`; a live mission still gets the board
- **Collector:** `commands/launchpad.js:424` (`collectLaunchpad`) reads the task projection, active missions, brain STATUS next move, and TODO endgame; emits `schema: atris.launchpad.v1`
- **Ranking:** `commands/launchpad.js:205` (`chooseNextAction`) own-claimed task > mission needing a tick > proof needing agent review > certified human-accept queue > open claim > endgame seed > brain next move > ask-for-work; `taskIsHumanGatedClaimed` skips claimed work gated on human accept; no `atris init` bootstrap
- **Suggestions:** `commands/launchpad.js:371` (`suggestedNextMoves`) returns up to 3 plain-language moves
- **Render:** `commands/launchpad.js:573` (`renderLaunchpad`) draws the ASCII card; `commands/launchpad.js:607` (`showLaunchpadHelp`)
- **Help:** `bin/atris.js:580` help line; **Routing:** `bin/atris.js:2479` dispatch, `lib/known-commands.js:3` `knownCommands`
- **Regression:** `test/first-minute.test.js` (empty first-talk, file names the file, post-mint already yours, post-init claim); `test/dogfood-p0-safety.test.js` `26d`/`26e`/`26h`/`26i`; `test/commands-7.test.js:1255` (actor-claimed first), `test/commands-7.test.js:1329` (clean queue to endgame seed), `test/commands-7.test.js:1365` (verifier mission when no claimed task); `--help` smoke at `test/commands-7.test.js:1199`
- **Value:** Answers "who is doing what, what needs review, what is blocked, what should start next" in one card without cloud auth

**Search:** `rg "launchpadCommand|collectLaunchpad|chooseNextAction|renderLaunchpad|suggestedNextMoves|speakFirstMinute|speakKeepWorkingMinute|atris.launchpad.v1" commands/launchpad.js lib/first-minute.js bin/atris.js test/commands-1.test.js test/first-minute.test.js test/dogfood-p0-safety.test.js`

## Feature: Analytics (`atris analytics`)

**Purpose:** Productivity insights from existing journal data

- **Entry point:** `commands/analytics.js:4-147` (analyticsAtris function)
- **Help:** `bin/atris.js:913-916` (`showAnalyticsHelp`) and `bin/atris.js:1479-1478` short-circuit `analytics --help` before workspace reads
- **Regression:** `test/commands-2.test.js:1476-1491` covers `analytics --help` without `atris/` or `$HOME/.atris`
- **Pareto insight:** No new instrumentation - parses existing markdown
- **Data sources:**
- Completions: `- **C#: description**` pattern
- Inbox items: `- **I#: description**` pattern
- Analyzes last 7 days from `logs/YYYY/YYYY-MM-DD.md`
- **Metrics:**
- Today's completions and inbox count
- Weekly total completions and velocity (avg/day)
- Inbox trend (Growing/Shrinking/Stable)
- Daily breakdown with visual bar chart
- **Output:** Terminal display with charts
- **Value:** Motivating insights without complexity

**Search:** `rg "analyticsAtris|showAnalyticsHelp|status and analytics --help" bin/atris.js commands/analytics.js test/commands-1.test.js`

## Feature: Brief (`atris brief`)

**Purpose:** One-glance operator surface: what landed with proof, what waits on the human, and the next ranked moves.

- **Entry point:** `commands/brief.js` (`buildBriefData`, `renderBrief`, `renderBriefHtml`, `briefCommand`)
- **Routing:** `bin/atris.js` (`command === 'brief'` branch, `knownCommands` list, Context & tracking help line)
- **Data sources:** `.atris/state/tasks.projection.json`, `lib/next-moves.js`, and `commands/report.js`
- **Regression:** `test/brief.test.js` (empty state, landed proof, review waits, JSON, HTML panel, no em dash, non-TTY prompt)

**Search:** `rg "buildBriefData|renderBrief|briefCommand|command === 'brief'" commands/brief.js bin/atris.js test/brief.test.js`

## Feature: Recap (`atris recap`)

**Purpose:** Spoken recap of what the AI team did for the operator. Receipts stay legible; zero internal jargon in output. `--share` is paste-ready for a customer.

- **Entry point:** `commands/recap.js` (`recapAtris`, `buildRecapData`, `renderRecapMinute`, `renderRecap`, `renderShare`)
- **Routing:** `bin/atris.js` (`command === 'recap'` branch, `knownCommands` list, Context & tracking help line)
- **Data sources:** task DB via `lib/task-db` (`listTasks` + `taskDisplayRefMap`); empty or missing db falls through to `.atris/state/tasks.projection.json`, same as first-minute
- **Buckets:** shipped = `done` within `--days` window (default 7); waiting = certified / two-pass `review` via `lib/first-minute.js` `isCertifiedReview` (needs human accept); checking = uncertified `review` (still being checked, not needs-you); in progress = `open`/`claimed`
- **Default:** `renderRecapMinute` talks like first-minute / review: a few spoken lines. Certified waiting names `atris task accept <id>`. Uncertified stays still being checked. No `RECAP` header, Plain English manifesto, or share footer.
- **Today (before any setup):** `atris recap today` always, and bare `atris recap` when the board has nothing to say (no tasks, or nothing shipped, waiting, checking, or in progress this window), print up to five plain lines from `lib/agent-today.js` (`buildAgentToday`, `renderAgentToday`, `hasActivity`): Claude Code logs under `$CLAUDE_CONFIG_DIR` or `~/.claude`, in `projects/<folder with non-alphanumerics as dashes>/`, Codex logs under `$CODEX_HOME` or `~/.codex`, in `sessions/YYYY/MM/DD/` whose `session_meta.payload.cwd` is inside this folder, and git commits since local midnight plus unsaved files. Counts typed asks (skips `<`-wrapped harness text and tool results) and edited files (Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, Codex `*** Add|Update|Delete File:` patch markers). Asks and sessions count only chats a person typed in; sessions a program started (Claude `promptSource: sdk` or `entrypoint: sdk-*`, Codex `originator: codex_exec`) are `autoRuns` on their own line, and Codex helpers (`source.subagent`) add files but no session. Folders are matched under every name they go by (`folderAliases`: the real path, the given path, and `$PWD` when it resolves to the same place), since both tools record the path you started in, which can run through a symlink. Claude Code names past 200 characters are cut to 200 plus `-<code>`, so those are found by prefix and confirmed by the `cwd` each log records. Codex logs are matched by their first line only (`readFirstJsonLine`) and fully read only when the folder matches. Saved and unsaved git fold into one line when the recap would pass five lines. Local only, sends nothing, writes nothing, needs no `atris/`. `--json` prints the raw counts. A brand new folder with commits but no ai session keeps the first-minute talk below; no session and no commits falls through to the old paths
- **Empty folder:** default spoken `atris recap` and `atris recap --json` reuse `speakFirstMinute` / `freshMinuteJson` only when there is no task history and no `atris/` room (same two spoken lines and next as bare `atris`, including a named file, last commit already here, or dirty open work still open, where next is `atris do`); a folder with task history keeps recap; `--verbose` / `--share` keep the empty report; `--help` stays usage
- **File folder after mint, no live mission:** default spoken `atris recap` and `atris recap --json` reuse `speakKeepWorkingMinute` when first-minute next is claimed keep-working (same `"notes.md" is already yours` / `next: atris task ready <id> --verify "git diff --check"` as status and the next keep-working). Not factory `Generate MAP.md` ready to claim. A claimed non-seed task still recaps that work. A live running mission and `--verbose` / `--share` keep the recap report
- **After init, next is claim, no live mission:** default spoken `atris recap` reuses `speakFirstMinute` when first-minute next is `atris task claim` (same claim line + one next as bare `atris` / `status` / `now` / `stop`). `--json` keeps the recap receipt and fills `next` from that same first-minute command (not null). `--verbose` / `--share` keep the recap report. A live running mission still recaps
- **Next:** one certified accept names `atris task accept <id>`; recap does not send humans to `atris task reviews` when that accept is the next move; keep-working recap names `atris task ready <id> --verify "git diff --check"`; post-init claim recap names `atris task claim <id> --as <user>`
- **Proof line:** `metadata.latest_agent_proof` (or certified marker), compressed to one line per item on `--verbose` / `--share`
- **Modes:** default spoken lines, `--verbose`/`--full` old report, `--share` (paste-ready for Slack/email/customer), `--json` (agents/dashboards), `--days N`
- **Regression:** `test/recap.test.js` (buckets, jargon ban, share format, projection fallback, empty workspace, empty-folder first-minute, certified-only needs-you, spoken default, verbose report, headless mixed board, post-mint claimed file not factory map.md, claimed non-seed still recaps, post-init claim keeps next); `test/first-minute.test.js` (`atris status after minting a file folder talks keep-working, not factory let-it-run` also locks recap and spoken `now`; `atris now after init --yes --minimal talks the claim, not factory now.md`; `atris recap after init --yes --minimal talks the claim, not silent next`); `test/dogfood-p0-safety.test.js` (`26e`, `26f`, `26g`, `26m`)

**Search:** `rg "recapAtris|buildAgentToday|renderAgentToday|renderRecapMinute|speakKeepWorkingMinute|isKeepWorkingMinute|isClaimMinute|plainCheck|isCertifiedReview|isRealTestRunnerProof|classifyVerifier" commands/recap.js lib/first-minute.js lib/verifier-quality.js lib/agent-today.js commands/task.js test/recap.test.js test/first-minute.test.js test/dogfood-p0-safety.test.js test/dogfood-p1.test.js`
rg "fleetWorkspaceStatus|fleet --global" commands/fleet.js test/dogfood-p1.test.js # Fleet defaults to workspace; --global hits Swarlo
rg "printRoster|registryPayload|canPersistEngineRegistry|speakFirstMinute|--global" commands/engine.js lib/engine-registry.js lib/first-minute.js test/engine.test.js test/first-minute.test.js test/dogfood-p1.test.js # Engine roster workspace vs --global; empty-folder engine/engines/--json talk first-talk and do not mint engines.json; a bound room still lists

## Feature: Visualize Artifacts (`atris visualize`)

**Purpose:** Generate Slack/deck-ready business visuals from a prompt, using workspace context and backend `gpt-image-2`.

- **Entry point:** `commands/visualize.js` (`visualizeAtris`, `generateVisual`, `buildImagePrompt`)
- **Prompt mode:** `atris visualize "<prompt>"` builds a structured image prompt, calls `/api/agent/{agent_id}/image/generate`, and saves PNGs under `atris/reports/visuals/`.
- **Defaults:** model `gpt-image-2`, size `1536x1024`, quality `high`; supports `--dry-run`, `--out`, `--agent`, `--open`, `--raw`.
- **Legacy mode:** no prompt still reads today's journal `## Inbox` and prints the old ASCII approval helper.
- **Value:** Turns workspace knowledge into polished visual artifacts without leaving the CLI.

**Search:** `rg "generateVisual|buildImagePrompt|visualizeAtris" commands/visualize.js`

## Concern: File System Operations

**Files:**

- `lib/file-ops.js` (289 lines): File/folder utilities
- `lib/journal.js` (172 lines): Journal-specific operations
- `lib/todo.js` (182 lines): TODO.md parser + team journal reader
- `lib/tree-hash.js:35` - deterministic agent text tree manifest and hash

**Operations:**

- Folder creation with safety checks
- File copying with existence checks
- Atomic writes
- Section-based markdown editing
- TODO.md structured parsing (parseTodo, parseSection)
- Team member journal aggregation (getTeamActivity)

**Pattern:** Always check existence before create/copy

**Search:** `rg "ensureLogDirectory|createLogFile" lib/journal.js`
