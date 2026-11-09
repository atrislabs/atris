# Boot and first minute

What runs when a session starts: activate, brain, setup, the first-minute view and the context gatherer. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Search shortcuts: Core CLI logic

```bash
rg "async function interactiveEntry|shouldGatherContext|renderContextGathererPrompt|buildFirstMinute|listUserVisibleWork|visibleWorkTitle|headCommitSubject|headBranchName|listDirtyWork|startFirstTalk|freshWinLine|freshNextCommand|laterNotePath|writeLaterNote|shouldAutoInitFresh|isTaskNextLook|isLeftoverVerbLook|isFirstTalkLine|speakNothingRunning" bin/atris.js lib/context-gatherer.js lib/first-minute.js commands/later.js commands/status.js    # Main entry points: cold-start dispatcher, first-minute bare atris screen, first-contact context gatherer, leftover task next and leftover words after brainstorm/wish/log/plan/do/later/mission/next are a look not first-talk, pasted talk line is first-talk not overview, a folder with user-visible files is named not empty, a git repo with a HEAD commit names that subject instead of the file listing, a named feature branch names the branch instead of the commit, a dirty tree names one or two open files or this folder still has open work, atris later remembers words in .atris-later without minting, atris do starts from those files, legacy natural-language mode
rg "brainstormAtris|Usage: atris brainstorm|brainstorm help|addInboxIdea|speakFirstMinute|Describe the desired outcome" commands/brainstorm.js lib/first-minute.js test/brainstorm-headless.test.js test/first-minute.test.js test/commands-1.test.js test/dogfood-p0.test.js  # Brainstorm: empty folder reuses speakFirstMinute (no mint); after init a named idea captures inbox and exits; no wizard; --json is a receipt or first-minute refuse
rg "statusAtris|showStatusHelp|speakNothingRunning|speakKeepWorkingMinute|isKeepWorkingMinute|isClaimMinute|status and analytics --help" bin/atris.js commands/status.js lib/first-minute.js test/commands-1.test.js test/first-minute.test.js test/dogfood-p0-safety.test.js # Status command + workspace-free help; empty-folder atris status talks first-talk (`nothing is running`, same talk next, no mint, no init); a file already here names that file and next is `atris do`, same as bare atris, and does not mint; after do mints that file folder with no live mission, status talks keep-working (`already yours` / `next: atris task ready <id> --verify "git diff --check"`), not factory let-it-run; after init --yes --minimal with no live mission, status talks the claim (same two lines as bare atris / now), not factory let-it-run; a live running mission still gets the board
```

## Search shortcuts: Modular commands

```bash
rg "doctorCommand|task_support|public bin shim" commands/doctor.js bin/atris.js package.json test/dogfood-p1.test.js # atris doctor --json: node, task-support 22+, auth, workspace, tiny POSIX bin shim (helpers stay internal)
rg "prepareBrainState|refreshNowFile|isGeneratedNowFile|brain compile refreshes stale now|preserves a custom now" commands/brain.js commands/now.js test/commands-1.test.js # Brain compile refreshes generated now.md before state collection while preserving custom front doors
rg "launchpadCommand|collectLaunchpad|chooseNextAction|renderLaunchpad|suggestedNextMoves|speakFirstMinute|speakKeepWorkingMinute|taskNeedsAgentReview|taskIsHumanGatedClaimed|atris.launchpad.v1" commands/launchpad.js lib/first-minute.js bin/atris.js test/commands-1.test.js test/first-minute.test.js test/dogfood-p0-safety.test.js  # Launchpad command-center card: empty and file folders reuse speakFirstMinute (same two spoken lines as bare atris, no mint, no init); post-mint keep-working and post-init claim reuse first-minute like status/now; a live mission still gets the board; ranks own-claimed > mission tick > proof review > human-accept queue > open claim > endgame seed > brain move; skips human-gated claimed work; --json (atris.launchpad.v1) and plain card on a live room
```

## Feature: Activate (`atris activate`)

**Purpose:** Load current workspace state, recent completions, and wiki health at session start

- **Entry point:** `commands/activate.js`
- **Reads:**
- `atris/PERSONA.md`
- `atris/MAP.md`
- `atris/TODO.md`
- today's journal under `atris/logs/`
- `atris/wiki/STATUS.md` when present
- **How it works:**
- creates today's journal if it is missing
- shows handoff and recent completions
- surfaces wiki summary bullets so the next session starts with project memory
- **Value:** prevents the local wiki from becoming write-only memory

**Search:** `rg "activateAtris|readWikiStatus" commands/activate.js lib/wiki.js`

## Feature: Brainstorm Mode (`atris brainstorm`)

**Purpose:** Named explore command. Capture one idea locally, then exit.

- **Entry point:** `bin/atris.js:2520` (command routing)
- **Handler:** `commands/brainstorm.js:71-101` (brainstormAtris function)
- **Help:** `commands/brainstorm.js:11-24` short-circuits before workspace/log setup; regression: `test/commands-7.test.js:2196-2211`
- **How it works:**
- Empty folder reuses `speakFirstMinute` (same two spoken lines as bare `atris`, talk command). No `atris/` or `.atris/` mint
- After `init --minimal`, `atris brainstorm "<idea>"` writes today's inbox and exits
- Never opens a TTY prompt or wizard, even when stdin is a TTY
- ATRIS_NO_INTERACTIVE=1 and no-tty return the same capture path
- `--json` is first-minute refuse before init and a real receipt after (`ok`, `action`, `inbox_id`, `next_command`)
- No idea after init prints the next capture command and exits
- **Workflow:** Optional step 0 before `atris plan`
- brainstorm (optional) → plan → do → review
- **Value:** Agents can file an idea in a room without a human at the keyboard. A scratch folder is not a room
- **Regression:** `test/first-minute.test.js` (`atris brainstorm in an empty folder talks like first-minute`); `test/brainstorm-headless.test.js` times out a hang

**Search:** `rg "brainstormAtris|Usage: atris brainstorm|speakFirstMinute|addInboxIdea" commands/brainstorm.js test/brainstorm-headless.test.js test/first-minute.test.js`

## Feature: Agent Activation Commands

**Purpose:** Direct activation of navigator/executor/validator modes

**Commands:**

1. **`atris plan`** - Navigator mode

- Entry: `commands/workflow.js:475-863` (planAtris function)
- Empty folder: `lib/first-minute.js` `buildFirstMinute({ fresh: true })` and `freshMinuteJson` (same two spoken lines and `--json` next as bare `atris`). No `navigator.md` bounce.
- Human head after init: `buildFirstMinute` (same two spoken lines as bare `atris`). No `PROMPT ONLY` banner on the default path.
- Factory paste stays on `--prompt` / `--verbose` / `--full`, or leftover words after `plan`. `--help` names `--prompt`.
- Missing `team/navigator` after `init --minimal` is optional context, not "run init". Regression: `test/workflow-command.test.js` (`plan in an uninitialized folder talks like first-minute`, `plan after init --yes --minimal does not send you back to init`, `plan names a claimed task the same way first-minute does`), `test/first-minute.test.js` (`atris plan in an empty folder talks like first-minute`, `atris do and plan after init --minimal stay two spoken lines`)

2. **`atris do`** - Executor mode

- Entry: `commands/workflow.js:868-1244` (doAtris function)
- Empty folder: `lib/first-minute.js` `buildFirstMinute({ fresh: true })` and `freshMinuteJson` (same two spoken lines and `--json` next as bare `atris`). No `executor.md` bounce.
- Files already here, no `atris/`: bare `atris` still names the files and `next: atris do`. A git repo in this folder with a HEAD commit names that clipped subject instead of the file listing; a dirty tree names one or two open files (`notes.txt is still open`) or says `this folder still has open work`; an empty `.git` or a repo with no commits still names files. `atris do` starts from those files (`lib/context-gatherer.js` `startFirstTalk`, title from `visibleWorkTitle`): `{file} is ready` / already claimed as the speaker / `next: atris task ready <id> --verify "git diff --check"`. A second `do` and bare `atris` after that stay two first-minute lines (`already yours` / the same ready next). It does not print `task claim` or `task show`, and it does not dump a factory banner. Empty or hidden-only folders still name the talk command and do not mint.
- After init, including MAP plus a claimed starter: default `do` reprints the same two spoken lines as bare `atris`. No `PROMPT ONLY` and no `executor.md not found`. `--prompt` / `--verbose` / `--full` prints the executor paste and file dump. `--help` names `--prompt`.
- Missing `team/executor` after `init --minimal` is optional context, not "run init". Regression: `test/workflow-command.test.js` (`do in an uninitialized folder talks like first-minute`, `do after init --yes --minimal does not send you back to init`, `do names a claimed task the same way first-minute does`), `test/first-minute.test.js` (`atris do in an empty folder talks like first-minute`, `atris do after init and claim stays in the room`, `atris do and plan after init --minimal stay two spoken lines`)

3. **`atris review`** - Human checkpoint, first-minute voice

- Entry: `commands/workflow.js:1337` `reviewAtris` / `renderReviewMinute` (`commands/workflow.js:115`)
- Empty folder: `lib/first-minute.js` `isFreshWorkspace` + `speakFirstMinute` (same two spoken lines and `--json` next as bare `atris`), including `--verbose`. No `validator.md` bounce and no lone `nothing is waiting on you.`
- After init: stay in the room. If first-minute next is `atris task claim|ready|accept`, review prints those same two spoken lines. Certified leads with the win and `atris task accept <id>`. Uncertified stays "still being checked", not needs-you. `nothing is waiting on you.` only when there is no claim/ready/accept next.
- `--all` / `--limit` / `--group-by`: certified queue via `task reviews`. After init, `--json` also keeps that queue.
- `--verbose` / `--full`: legacy Validator prompt. Missing `team/validator` after `init --minimal` is optional context, not "run init"
- Headless never prompts (`isNonInteractive`)
- `--help` stays usage
- Regression: `test/workflow-command.test.js` (`review in an uninitialized folder talks like first-minute`, `review after init --yes --minimal does not send you back to init`, `review talks like first-minute`, `renderReviewMinute names an open claim`), `test/first-minute.test.js` (`atris review in an empty folder talks like first-minute`, `atris review after init --minimal matches bare atris claim next`)

4. **`atris launch`** - REMOVED (was dead code, deleted)

**Flow:** `atris → plan → do → review → loop`

**Search:** `rg "planAtris|doAtris|reviewAtris" bin/atris.js`

## Feature: Guided Setup (`atris setup`)

**Purpose:** First-time setup checks Node.js, login state, businesses, and optional business pull.

- **Entry point:** `commands/setup.js:6-178` (`setupAtris`)
- **Help:** `bin/atris.js:1089-1092` (`showSetupHelp`) prints setup usage without entering setup
- **Dispatch:** `bin/atris.js:1498-1499` routes `setup --help`, `setup -h`, and `setup help` before login, business fetch, or pull flow
- **Regression:** `test/commands-2.test.js:1468-1479` covers setup help without setup banner, login prompt, or `.atris` creation
- **Value:** Gives first-run guidance while keeping help safe in temp homes and automation.

**Search:** `rg "showSetupHelp|setupAtris|setup --help" bin/atris.js commands/setup.js test/commands-1.test.js`

## Feature: Context Activation (`atris activate`)

**Purpose:** Load Atris context - MAP.md, journal, tasks - and display system status

- **Entry point:** `commands/activate.js:158-306` (activateAtris function)
- **Routing:** `bin/atris.js:1160-1159`
- **Help:** `bin/atris.js:932-935` (`showActivateHelp`) prints usage before context loading or journal creation
- **Regression:** `test/commands-2.test.js:1499-1513` covers activate help without context panels or temp state creation; `test/activate-boot.test.js` covers the boot brief + sync-status line
- **Logic:**
- Detects workspace state via `lib/state-detection.js`
- Loads MAP.md, TODO.md, today's journal
- Shows context summary (inbox, backlog, in progress, completions)
- Ends with the one-line brief (`renderBrief` first line) + one cloud sync line (`sync: in sync|N files drifted|offline`) via `lib/sync-status.js` (`syncStatus`/`driftCount`, local-only vs `lib/manifest.js`)
- **Value:** Quick context reload without natural language entry

**Search:** `rg "activateAtris|showActivateHelp|activate and next --help" bin/atris.js commands/activate.js test/commands-1.test.js`

## Feature: State Detection

**Purpose:** Smart context loading based on workspace state

- **Entry point:** `lib/state-detection.js:4-138`
- **Functions:**
- `detectWorkspaceState()` (lines 4-80): Detect state (uninit/active/stale)
- `loadContext()` (lines 82-138): Load relevant context
- `hasBlockedTasks()` (`lib/state-detection.js:280`): blocked means a failed task in the task DB; when this workspace has no rows there, only the TODO.md Blocked section counts (`test/state-detection-blocked.test.js`)
- **States:**
- Uninitialized: No atris/ folder
- Active: Recent journal entries
- Stale: No activity in 7+ days
- **Value:** Adaptive context loading

**Search:** `rg "detectWorkspaceState|loadContext" lib/state-detection.js`

---

## Feature: First-Contact Context Gatherer

**Purpose:** First `atris` contact asks for human context before planning or agent bootstrap, then persists the answer and creates a starter onboarding task.

- **Entry point:** `bin/atris.js` (`interactiveEntry`)
- **First-minute screen:** `lib/first-minute.js` (`buildFirstMinute`, `freshMinuteJson`, `speakFirstMinute`) prints one win and one next command for bare `atris`, default `atris task` (`commands/task.js` `cmdFirstMinute`), `atris task next` (`commands/task.js` `cmdNext`), `atris task new` (`commands/task.js` `cmdAdd`), `atris plan`, `atris do`, and `atris review` (`commands/workflow.js` `planAtris` / `doAtris` / `reviewAtris`), bare `atris wish` (`commands/wish.js` `printWishReceptionist`), `atris log` (`commands/log.js` `logAtris`), bare `atris recap` (`commands/recap.js` `recapAtris`, after do mints a file folder with no live mission recap reuses `speakKeepWorkingMinute`; after init --yes --minimal with no live mission recap reuses `speakFirstMinute` when next is claim, same two lines as bare atris / status / now / stop, and `--json` fills `next` from that claim), and bare `atris ask` / `atris mission` / default `atris mission status` (`commands/human-missions.js` `askCommand`, `commands/mission.js` `missionCommand` / `speakMissionDoor` / `isLiveInFlightMission`); empty-folder `atris stop` (`commands/human-missions.js` `stopCommand` / `speakNothingRunning`) and empty-folder `atris status` (`commands/status.js` `statusAtris` / `speakNothingRunning`) say `nothing is running` and name the same talk command; a file already here names that file or last commit and next is `atris do`, same as bare atris, and does not mint; after do/claim with no live mission, `stopCommand` reuses `speakKeepWorkingMinute` (same `already yours` / ready next as status/recap), not factory cloud-computer, and does not mint or bind; after init --yes --minimal with no live mission, `stopCommand` reuses `speakFirstMinute` (same claim / one next as bare atris / status / now), not factory cloud-computer, and does not mint or bind; a running mission or a recent tick with a live driver shows one card; a stalled ready row with no live driver speaks the same claim/ready/accept next as bare `atris`; empty-folder `mission status` and `mission list` reuse that screen; the archive stays on `mission list` or `mission status --all`; `mission --help` is a short keep-working page (full dump on `help --full`); empty folders say the room is empty and name `atris "what do you want here?"`; a folder with user-visible files names one or two of them (`notes.txt is already here`) or says `this folder already has work` and names `atris do`; if this folder is a git repo with a HEAD commit, `headCommitSubject` speaks that clipped subject as already here instead of listing files; on a named feature branch (not main/master, not detached), `headBranchName` speaks that clipped branch instead of the commit (no hash, no origin/); `listDirtyWork` still speaks one or two open files (`notes.txt is still open`) or `this folder still has open work` when the tree is dirty, and open work beats the branch; an empty `.git` or a repo with no commits still names files; a parent repo is ignored when this folder has no `.git`; hidden names (`.DS_Store`, `.git`) do not count, so a folder of only hidden files stays empty and still names the talk command; files and `.git` do not mint a room; listing `atris do` as next does not mint; running `atris do` with those files starts first-talk from `visibleWorkTitle` (`{file} is ready` / already claimed as the speaker / `atris task ready <id> --verify "git diff --check"`) via `startFirstTalk`; a first sentence through bare atris (`lib/context-gatherer.js` `createStarterTask` / `starterTaskTitle`) files that sentence as a claimed task for the speaking user (soft-clipped if long, no `first useful step:` prefix) and `renderFirstTalk` / `firstTalkNext` say `{title} is ready` plus that same ready next; a second `do` stays two first-minute lines (`already yours` / the ready next) and does not loop `atris do`; pasting the talk line (`isFirstTalkLine`) still starts first-talk and files a short honest title like `this folder` or the room name, never `first useful step: what do`; leftover command words (`task next`, `task new`, `wish`, `log`, `brainstorm`, `plan`, `do`, `review`, `ask`, `mission`) match that two-line screen and do not mint work, including quoted leftover after those verbs (`isLeftoverVerbLook`, quoted `task next` still via `isTaskNextLook`); after `init --minimal` those commands still file or capture; `wish --help`, `ask --help`, `mission --help`, `task next --help`, `task new --help`, `review --help`, `log --help`, `recap --help`, and `brainstorm --help` stay usage; `shouldAutoInitFresh` runs `init --minimal` on `--yes`/`-y` even under `ATRIS_NO_INTERACTIVE`; `--json` without a request names the talk command when the folder is empty, or `atris do` when files are already here; claimed work names `atris task ready <id> --verify "git diff --check"`; any review names `atris task accept <id>` and says something finished. waiting on you (id only on next, never shipped, never `review-chat`); throwaway names (`tmp`, `temp`, `atris-*`, hashes) stay "this folder"; a real basename like `launch-day` stays even under `/tmp`; person name prefers the saved account first name
- **Scratch-root room:** `lib/scratch-root.js` `isGenericScratchRoot` names `/tmp`, `/private/tmp`, `/var/tmp`, and `os.tmpdir()`. `isUnderGenericScratchRoot` / `isUnboundScratchFolder` treat an empty child under those roots as not a room (`--yes` is not an unlock). `commands/spaceship.js` and `commands/autopilot-front.js` refuse that start with `this folder is not a room` and exit 2 (no email, no overnight process, no `.atris/` or `atris/` mint). Bare spaceship / autopilot without `--yes` still talk and do not start. A child that already has `atris/` or `.atris/business.json` can still start. `lib/task-db.js` `findWorkspaceRoot` stops before walking into those parents, so an empty child under `/tmp` does not inherit `/tmp`'s tasks or missions. `cd src` in a real project still walks up, including `atris recap`. Regression: `test/scratch-root-room.test.js`, `test/task-workspace-root.test.js`, `test/dogfood-spaceship-scratch.test.js`, `test/dogfood-hours-lingo.test.js`
- **Placeholder MAP:** after init, `bin/atris.js` `interactiveEntry` keeps `atris test` and other requests on first-minute when `MAP.md` is placeholder or missing. The generate-map task is already yours or ready to claim. It does not print `BOOTSTRAP REQUIRED` or ask an agent to rewrite MAP as a wall. Empty folders with no `atris/` name the talk command. Headless never prompts. Regression: `test/first-minute.test.js`
- **Task desk next:** `lib/first-minute.js` (`deskNextCommand`) reuses `pickNext`/`taskCommand` for `commands/task.js` `renderTaskDesk` on `atris task desk` and `atris task --all`; claimed desk copy is `atris task ready <id> --verify "git diff --check"`
- **Task next:** `commands/task.js` (`cmdNext`, `cmdNextTruth`) reuses `speakFirstMinute` in an uninitialized folder (same two spoken lines as bare `atris`, talk command, no `atris task new`, no `.atris/` or `atris/` mint); `bin/atris.js` `interactiveEntry` uses `isLeftoverVerbLook` so quoted leftover after `task next` / `brainstorm` / `wish` / `log` / `plan` / `do` is also a look, not first-talk; after a real room (`init --minimal` or the pasted talk line) it reuses `pickNext`/`taskCommand`/`taskNextCommand` so `atris task next` names the same accept/ready/claim/new command as bare atris and the desk; a claimed row never prints `No open tasks`; `--create-next` still seeds Endgame fallback; `--help` stays usage. Regression: `test/task-next-scratch-nomint.test.js`
- **Task new:** `commands/task.js` (`cmdAdd`) reuses `speakFirstMinute` in an uninitialized folder (same two spoken lines as bare `atris`, talk command, no task id, no `.atris/state/tasks.projection.json`); after `init --minimal` a title still files; `--help` stays usage
- **Log:** `commands/log.js` (`logAtris`) reuses `speakFirstMinute` in an uninitialized folder (same two spoken lines as bare `atris`, talk command, no `atris/logs`); after `init --minimal` a note still captures as inbox; `--json` is first-minute refuse before init and `inbox_capture` after; `--help` stays usage
- **Brainstorm:** `commands/brainstorm.js` (`brainstormAtris`) reuses `speakFirstMinute` in an uninitialized folder (same two spoken lines as bare `atris`, talk command, no inbox row); after `init --minimal` a named idea still captures and exits; `--json` is first-minute refuse before init and a capture receipt after; `--help` stays usage
- **Helper:** `lib/context-gatherer.js`
- **State:** `.atris/state/context_profile.json`
- **Regression:** `test/first-minute.test.js`, `test/task-next-scratch-nomint.test.js`, `test/brainstorm-headless.test.js`, `test/task-first-minute.test.js`, `test/task-desk-next.test.js`, `test/task-next-truth.test.js`, `test/context-gatherer.test.js`, `test/cli-smoke.test.js`, `test/workflow-command.test.js`, `test/wish.test.js`, `test/human-missions.test.js`, `test/log-inbox.test.js`, `test/scratch-root-room.test.js`, `test/task-workspace-root.test.js`
- **Search:** `rg "shouldGatherContext|saveContextProfile|createStarterTask|startFirstTalk|starterTaskTitle|visibleWorkTitle|headCommitSubject|listDirtyWork|renderFirstTalk|buildFirstMinute|listUserVisibleWork|freshWinLine|freshNextCommand|freshMinuteJson|speakFirstMinute|speakNothingRunning|speakKeepWorkingMinute|isKeepWorkingMinute|isFreshWorkspace|isTaskNextLook|isLeftoverVerbLook|printWishReceptionist|isWishDeskVerb|cmdFirstMinute|isUninitializedTaskFolder|cmdAdd|deskNextCommand|taskNextCommand|cmdNext|cmdNextTruth|reviewAtris|logAtris|brainstormAtris|recapAtris|statusAtris|isLiveInFlightMission|pickLiveLocalMission|Context gatherer" bin/atris.js lib/context-gatherer.js lib/first-minute.js commands/task.js commands/workflow.js commands/wish.js commands/human-missions.js commands/mission.js commands/status.js commands/log.js commands/brainstorm.js commands/recap.js test

---
