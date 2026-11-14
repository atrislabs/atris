# Business and cloud

Business owners and computers, cloud sync, pull and push, sites and the local computer bridge. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Product Model: Owners Have Computers

This repo is the public CLI surface, so product language matters here.

Core model:

```text
Owner = User | Business
Owner has many Computers
Computer = workspace + files + tools + secrets + memory + agents + validation/RL loop
```

Keep `business` as the shared owner in the schema and CLI internals.
Externally, a business owner may be a company, lab, collective, community, artist, team, or project.
Computer type carries the function: `business_ops`, `codeops`, `research`, `crm`, `reporting`, `event_ops`, or `support`.

For details, read `atris/wiki/concepts/owner-computer-model.md` before changing business/computer commands or public help text.

**Search Patterns (ripgrep shortcuts):**

## Search shortcuts: Modular commands

```bash
rg "Plan only|refuseBrainWriteWithoutYes|--yes" commands/sync.js commands/brain.js bin/atris.js test/dogfood-pass2.test.js  # update/brain default plan-only; writes require --yes; non-TTY without --yes exits 2
rg "isProtectedHook|isArchivedMember|newer template exists" commands/sync.js test/update-preserves-team.test.js  # update never re-adds archived members, never replaces a changed MEMBER.md, never downgrades a project hook
rg "syncCheckoutCommand|checkoutBehindMessage|trackedTreeIsClean" commands/sync-checkout.js lib/checkout-sync.js bin/atris.js commands/status.js test/sync-checkout.test.js  # Current-branch fetch + fast-forward command (--backup saves tracked edits to ~/.atris/backups/<repo>/ first) and boot/status upstream-behind warning
rg "logSyncAtris" commands/log-sync.js      # Log sync command
rg "requireAccountBound|account-global|isBoundBusinessWorkspace|looksLikeBusinessSlug|--account|helpOnly|Pass --yes to create a live business|Pass --yes to publish" lib/account-bound.js bin/atris.js commands/business.js commands/terminal.js commands/fleet-report.js commands/site-deploy.js commands/chat-scan.js test/dogfood-pass2-t1-t5.test.js test/dogfood-pass4.test.js test/dogfood-unbound-live-writes.test.js test/business-ship.test.js  # Unbound folders refuse business/rainmaker/avail/feedback/agent/terminal/fleet-report/site deploy unless --account; bare business, --help, help, and quickstart print usage without --account; business ship and site deploy also need --yes; terminal/fleet-report parse --help/--json before slug; looksLikeBusinessSlug (lib/account-bound.js:18) rejects --json/--help
rg "businessCommand|createCanonicalBusinessWorkspace|startBusinessWorkspace|shareBusinessWorkspace" commands/business.js lib/business-core.js  # Business workspace flows and collaborator handoffs
rg "computerCreate|computerSetup|formatEngineSeats|runEngineSeatsCommand|readyCheckEngineLogin|computerActivate|computerDelete|parseComputerCreateArgs|parseComputerDeleteArgs|computerLocal|buildComputerCard|computerCard|resolveBusinessContext|ensureBusinessAwake|workspaceMismatchHint|ENGINE_SEED_META|normalizeModels|normalizeDuty|printRoster|speakFirstMinute|canPersistEngineRegistry" commands/computer.js lib/computer-core.js commands/engine.js lib/engine-registry.js lib/first-minute.js test/engine.test.js test/first-minute.test.js test/computer-create.test.js  # AI computer lifecycle/local/cloud/card, named engine seat visibility, config-driven engine models and duties, setup live proof, explicit business-computer activation, readiness, and workspace-mismatch recovery; empty-folder engine/engines/--json reuse speakFirstMinute and skip engines.json seed
rg "hostAction|archiveOutbox|hostDeliver|hostCommand|locked|memberInstall|updateMemberSkills|command === 'host'" lib/host.js commands/host.js commands/member.js lib/member-scaffold.js bin/atris.js test/host.test.js  # Host room setup, introductions, Slack delivery, draft outbox, archival, packaged member install, and skill update tests: lib/host.js:315 lib/host.js:94 commands/host.js:24 commands/member.js:4302 lib/member-scaffold.js:194 bin/atris.js:3309 test/host.test.js:95
rg "pullAtris|pullBusiness" commands/pull.js  # Cloud pull (journals + businesses)
rg "pushAtris|buildPushChangePlan|buildPushUploadBatches|sync?timeout" commands/push.js test/push-scoped.test.js  # Cloud push: manifest-hash skip, small upload batching through /sync, delete guard, and S5 regression
rg "cloudAtris|cloudClean|collectCloudOrphans|parseCloudCleanArgs|showOrphans" commands/cloud.js commands/business-sync.js bin/atris.js lib/known-commands.js test/cloud-clean.test.js  # Cloud clean: list/delete cloud files not present locally, and sync --status --show-orphans
rg "businessSync|parseBusinessSyncArgs|--watch|command === 'watch'|knownCommands" commands/business-sync.js bin/atris.js lib/known-commands.js test/watch.test.js  # Business sync/watch surface, including top-level `atris watch` alias for `sync --watch`
rg "businessRoom|businessProducts|businessOrders|businessStore|normalizeOrdersPayload|deployBusiness|files failed to upload" commands/business.js lib/business-core.js bin/atris.js test/business-ops.test.js test/business-deploy.test.js  # Live business room, product/order lists, the web-compatible storefront switch, and truthful workspace upload failures over the production HTTP API
rg "liveCommand|runFreshnessCycle|collectSnapshot" commands/live.js  # Keep business brain fresh by doctor/pull/watch/push
```

## Feature: Spec Update (`atris update`, `atris update --all`)

**Purpose:** Updates local atris.md to latest package version. `--all` propagates across every atris project under cwd.

- **Entry point (single project):** `commands/sync.js:478` (syncAtris function)
- **Entry point (workspace):** `commands/sync.js:976` (syncAtrisAll function)
- **Startup/help guard:** `bin/atris.js:207-212` skips global and project skill sync for every help invocation; `bin/atris.js:1765-1791` dispatches `update|sync --help` before command-specific template sync work
- **Discovery helper:** `commands/sync.js:892` (_findAtrisProjects: walks subtree, max depth 8, skips node_modules/.git/dist/build/worktrees)
- **Single-project logic:**
- Validates atris/ folder exists
- Compares content with package atris.md
- Copies new version if different
- Prompts user to regenerate MAP.md and agents
- `--dry-run` is write-free across startup skill sync, core files, migrations, project skills and symlinks, Claude adapters/settings, and wiki scaffolding; it prints each planned change and a summary instead
- **Workspace logic (`--all`):**
- Scans cwd recursively for every `atris/atris.md`
- Builds per-project plan (added/changed/skipped), prints before writing
- Skips real business workspaces (detected by business template header `# Atris Boot Protocol`): those route through `syncWorkspaceTemplate`
- atris-cli itself always dogfoods canonical files regardless of business.json
- Confirms before writing unless `--force` / `--yes` / `-y`
- `--dry-run` prints the plan and exits
- **Regression:** `test/commands-1.test.js` covers `update --help` and `sync --help` as non-mutating usage output, including a stale global skill sentinel under a temporary HOME
- **Dry-run regression:** `test/update-dry-run.test.js` snapshots a minimal project plus temporary-HOME global skill, then proves single-project `update --dry-run` and `sync --dry-run` leave both trees byte-for-byte unchanged
- **Business dry-run regression:** the same file proves a stale business skill is counted as a planned update while project and temporary-HOME trees remain byte-for-byte unchanged
- Update and sync previews also skip `lib/usage.js` telemetry so an existing `.atris/` directory does not gain `state/usage.jsonl` during a dry run; normal commands still record usage
- Update and sync help use the same telemetry guard, and the business fixture proves both help paths leave workspace and temporary-HOME trees byte-for-byte unchanged
- The central CLI dispatcher suppresses usage telemetry for every help path, including bare help; business snapshots cover bare, update, sync, upgrade, and now help while normal commands still record usage
- The same dispatcher guard applies to every `--dry-run`; a real business-workspace `clean --dry-run --json` snapshot proves previews do not create usage state, while normal telemetry tests remain green
- **Value:** Keep canonical docs (atris.md, PERSONA.md, GETTING_STARTED.md, CLAUDE.md) in sync across a multi-project workspace in one command

**Search:** `rg "showUpdateHelp|syncAtris|syncAtrisAll|_findAtrisProjects|update and sync --help" bin/atris.js commands/sync.js test/commands-1.test.js`

## Feature: Pull (`atris pull`)

**Purpose:** Pull remote journal/business data into the local workspace

- **Entry point:** `commands/pull.js:116-204` (pullAtris function)
- **Helpers:** `pullBusiness` (`commands/pull.js:207`), `pullGeneralJournal` (`commands/pull.js:1019`), `pullMemberJournal` (`commands/pull.js:1084`)
- **Exports:** `module.exports = { pullAtris }` (`commands/pull.js:688`)

**Search:** `rg "pullAtris" commands/pull.js`

## Feature: Push (`atris push`)

**Purpose:** Publish local workspace files to the business cloud workspace, with narrow defaults for safe scoped pushes

- **Entry point:** `commands/push.js` (`pushAtris`)
- **Scoped push (S4):** `parsePushArgv` / `mergePushScopes` / `resolveChangedScopePaths`: `atris push <file...>` and `atris push --changed` (manifest hash diffs via `lib/manifest.js`) become `onlyPrefixes` for `buildPushChangePlan`
- **Safety:** drift gate (S1 safe-path-first message with `atris sync --review` and `atris push --only` escape hatches via `renderDriftBlock`), mass-delete guard, `analyzePushSafety` / `renderPushSafetyBlock`, `--force --allow-broad-workspace` requires interactive y/N confirm (skippable with `--yes`) via `needsForceBroadWorkspaceConfirm` / `promptConfirm`
- **Regression:** `test/push-scoped.test.js`, `test/push-delete-safety.test.js`, `test/push-safety-ux.test.js`

**Search:** `rg "parsePushArgv|mergePushScopes|resolveChangedScopePaths|buildPushChangePlan|renderDriftBlock|needsForceBroadWorkspaceConfirm|promptConfirm" commands/push.js test/push-scoped.test.js test/push-safety-ux.test.js`

## Feature: Sync review conflict handler (`atris sync --review`)

**Purpose:** S2 default conflict handler. Lists each conflicting file from the latest `.atris/sync/conflicts/*` packet, then picks local / cloud / merge. Non-interactive via `--take local|cloud`. Merge writes standard `<<<<<<< local` markers into the target file and never dumps workspace `*.remote` sidecars.

- **Entry:** `commands/business-sync.js` (`businessSync` when `--review`)
- **Core:** `runSyncReview`, `applyReviewChoice`, `buildConflictMarkers`, `listConflictFiles`
- **Args:** `parseBusinessSyncArgs` (`--review`, `--take local|cloud`, `--path`)
- **Packet source:** `collectConflictResolutionEntries` (reads `*.local` / `*.remote` under latest conflict dir)
- **Regression:** `test/sync-review.test.js`

**Search:** `rg "runSyncReview|buildConflictMarkers|applyReviewChoice|--take" commands/business-sync.js test/sync-review.test.js`

## Feature: Live Brain Sync (`atris live`)

**Purpose:** Keeps a business workspace fresh for nontechnical operators.

- **Entry point:** `bin/atris.js` dispatch for `live`
- **Handler:** `commands/live.js`
- **Core flow:** `business doctor --fix` → `push <business>` → `pull <business>` → watch local files → debounced `push <business>` → periodic pull
- **Safety:** `--dry-run` prints the planned commands without cloud writes; failures stop the loop instead of auto-merging conflicts.
- **Value:** Operators can live inside the workspace without remembering pull/push hygiene.

**Search:** `rg "liveCommand|runFreshnessCycle|collectSnapshot" commands/live.js`

## Feature: Cloud Clean (`atris cloud clean`)

**Purpose:** List and delete cloud files that are not present locally, and surface them in `atris sync --status`.

- **Entry point:** `bin/atris.js` dispatch for `cloud` (`command === 'cloud'`) routes to `commands/cloud.js`
- **Handler:** `commands/cloud.js` (`cloudAtris`, `cloudClean`, `collectCloudOrphans`, `parseCloudCleanArgs`, `renderCloudCleanSummary`)
- **Args:** `atris cloud clean [business] [--dry-run] [--yes] [--delete-all]`
- **Status integration:** `commands/business-sync.js` (`businessSync`) supports `--status --show-orphans` and uses `collectCloudOrphans` from `commands/cloud.js`
- **Safety:** mass delete guard from `commands/push.js` (`isMassDeletePlan`) blocks `--yes` unless `--delete-all` is also passed
- **Known commands:** `lib/known-commands.js` includes `cloud`
- **Regression:** `test/cloud-clean.test.js`

**Search:** `rg "cloudAtris|cloudClean|collectCloudOrphans|parseCloudCleanArgs|showOrphans" commands/cloud.js commands/business-sync.js bin/atris.js lib/known-commands.js test/cloud-clean.test.js`

## Feature: Business Owners + Computers (`atris business`)

**Purpose:** Create, inspect, and sync shared business owners and their default computers, including the standalone `.atris/business.json` + `atris/` shape used for local-first business environments

- **Entry point:** `commands/business.js`, `lib/business-core.js`
- **Key flows:**
- `createBusinessInternal()` (`commands/business.js`) creates the cloud business record, caches IDs locally, and can now scaffold a default business environment
- `renderBusinessCreatedNextSteps()` (`lib/business-core.js`) renders the post-`business init` operator path: `business start`, `radar`, `task next`, member activation, mission bootstrap, onboarding, record/share, and `align --fix`
- `initBusinessWorkspace()` (`commands/business.js`) is the first-class path for `atris business init <name>`; product meaning is "create shared owner + first/default computer"
- `onboardBusiness()` (`lib/business-core.js`) works from sparse input or loose local files, then seeds raw intake, a starter brief, one person page, a first-loop page, a safe next action, an operator one-pager, a fallback starter row in `atris/TODO.md`, and a durable starter task in `.atris/state/tasks.projection.json` when `lib/task-db` is available. Accepts `--name` to auto-scaffold `.atris/business.json` in a bare directory.
- `startBusinessWorkspace()` (`commands/business.js`) powers `atris business start|check|ready`; it reads a received workspace, prints readiness, missing artifacts, first reads, first-loop commands including `atris radar`, `atris task next`, and `atris do`, mission bootstrap commands (`mission status`, `mission start`, `member goal-from-mission`), compact local Atris OS state from `.atris/state` + `atris/team`, and the `atris update` repair command when root agent adapters are missing. Supports `--cwd <path>` for handoff links.
- `shareBusinessWorkspace()` (`lib/business-core.js`) prints/writes a collaborator handoff with workspace identity, local `cd` path, cloud-aware remote `atris pull <slug>` setup when IDs exist, readiness, exact start commands with `atris radar`, `atris task next`, and `atris do`, first-loop/proof commands, mission bootstrap/resume commands, sync commands, task/review counts, mission loop state, team active-goal counts, AgentXP gate state, and missing next action. Missing root agent adapters point collaborators to `atris update`.
- `recordBusinessRun()` (`lib/business-core.js`) appends a finished recap into `.atris/state/events.jsonl`, `episodes.jsonl`, and `scorecards.jsonl`
- `createCanonicalBusinessWorkspace()` (`lib/business-core.js`) writes `.atris/business.json`, reuses `syncBusinessCanonical()` from `commands/sync.js`, then calls `ensureBusinessRootAgentAdapters()` from `commands/sync.js` to seed root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` adapters for collaborator first-run guidance while preserving custom existing adapters
- `syncBusinessCanonical()` (`commands/sync.js`) applies `templates/business-starter/` into a business workspace without clobbering custom files and repairs missing root agent adapters during `atris sync` / `atris update`; `renderBusinessAgentAdapter()` seeds root `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` with `atris business start`, `atris radar`, task next, member activation, mission bootstrap, and `atris do`
- Starter business environments seed `atris/team/START_HERE.md`, `operator`, and `validator` member folders so a collaborator knows which lane to wake first and when proof needs review
- **Default local target:** `~/arena/atris-business/<slug>/`, or `--here` / `--root <dir>` when you want to bind an existing folder
- **Value:** Makes shared owners and their computers a real CLI primitive instead of a manual `.atris/business.json` + `atris update` ritual

**Search:** `rg "initBusinessWorkspace|onboardBusiness|startBusinessWorkspace|shareBusinessWorkspace|createCanonicalBusinessWorkspace|ensureBusinessRootAgentAdapters|syncBusinessCanonical" commands/business.js lib/business-core.js commands/sync.js`

## Feature: Computer Card (`atris computer card`)

**Purpose:** Print or write an inspectable local card for the current workspace computer, no login or backend call required.

- **Entry point:** `commands/computer.js:2059` (`runComputer` dispatch handles `card` before auth)
- **Builder:** `lib/computer-core.js:1441` (`buildComputerCard`)
- **Writer:** `lib/computer-core.js:1536` (`computerCard`)
- **How it works:**
- Reads `.atris/business.json` when present for owner/workspace metadata
- Falls back to `package.json` and folder name for project workspaces
- Detects memory paths (`atris/MAP.md`, `atris/TODO.md`, wiki, logs), validation command, proof command, and visual command
- `--write` saves markdown to `computer-card.md` in `atris/reports/` (or the project root when there is no `atris/` folder)
- **Value:** Turns the owner/computer model into a concrete artifact a teammate can inspect.

**Search:** `rg "buildComputerCard|computerCard" commands/computer.js lib/computer-core.js`

## Feature: Pull Request From A Task (`atris computer pr`)

**Purpose:** A GitHub repo and a plain-words task go in; the business computer does the work on a new branch, opens one pull request, and the command prints the link. It never merges.

- **Entry point:** `commands/computer.js:2352` (`case 'pr'` in `runComputer`)
- **Command:** `commands/computer.js:1093` (`computerPr`): wakes the computer, posts `/business/{id}/chat` with the instruction, streams the run through a redacting writer, exits 0 only on a same-repo pull request link
- **Instruction and parsing:** `lib/computer-pr.js:75` (`buildPullRequestPrompt`, starts with "GitHub task:" so the server attaches the caller's GitHub access), `lib/computer-pr.js:154` (`parsePullRequestResult`), `lib/computer-pr.js:198` (`redactSecrets`)
- **Run text:** `commands/computer.js:1191` (`streamBusinessChatResult` returns `{ok, status, text, resultText}` and takes optional `write`/`writeError`)
- **Tests:** `test/computer-pr.test.js`

**Search:** `rg "computerPr|buildPullRequestPrompt|parsePullRequestResult|redactSecrets" commands/computer.js lib/computer-pr.js test/computer-pr.test.js`

## Feature: Computer Account Setup (`atris computer setup`)

**Purpose:** Guide a non-technical operator through choosing a computer and connecting named Codex or Claude accounts.

- **Entry point:** `commands/computer.js` (`runComputer` dispatches `setup` to `computerSetup`)
- **Computer list:** reuses `GET /business/`, with the personal computer as the fallback when no business computer is returned
- **Login flow:** reuses `runEngineDeviceLoginCommand()` from `commands/engine.js` with `{ target, seat }`; Codex shows its device code, while Claude reads the browser-generated code through injected readline and posts it back to the login session
- **Named seats:** `normalizeEngineLoginSeat()` converts spaces and dashes to uppercase underscores and validates the backend's 1-48 character rule before any API call
- **Receipt:** reuses `listEngineLogins()` and prints each account linked during setup
- **Tests:** `test/engine.test.js` covers device-code and Claude paste-back flows; `test/computer-create.test.js` covers setup guidance and dependency passthrough

**Search:** `rg "computerSetup|setupComputerChoices|normalizeEngineLoginSeat|listEngineLogins" commands/computer.js lib/computer-core.js commands/engine.js test/engine.test.js`

## Feature: Local AI Computer Bridge (`atris serve`)

**Purpose:** Register the current directory as a live local AI Computer session so cloud agents can apply bounded file operations.

- **Known command:** `lib/known-commands.js:4` includes `serve`, so the explicit branch is reachable before natural-language fallback
- **Help:** `bin/atris.js:1131-1136` (`showServeHelp`) prints usage without auth checks or bridge startup
- **Dispatch:** `bin/atris.js:1129-1143` routes `serve --help`, `serve -h`, and `serve help` before parsing bridge options; normal runs call `serveAtris`
- **Handler:** `commands/serve.js:306-407` (`serveAtris`) registers the session and subscribes for operations
- **Safety core:** `commands/serve.js:55-78` (`safePath`) and `commands/serve.js:83-176` (`applyOp`) constrain file operations
- **Regression:** `test/commands-2.test.js:1482-1494` covers `serve --help` without planner fallback, bridge startup, login checks, or auth-state creation

**Search:** `rg "serveAtris|showServeHelp|command === 'serve'|serve --help" bin/atris.js commands/serve.js test/commands-1.test.js`

## Feature: Journal Sync (`atris log sync`)

**Purpose:** Bidirectional sync between local journal and cloud

- **Entry point:** `commands/log-sync.js:39-385` (logSyncAtris function)
- **Strategy:** Timestamp comparison + user choice (no complex merge)
- **Logic:**
- Fetches remote journal entry
- Compares timestamps
- If remote newer: prompts to pull
- If local newer: pushes to cloud
- Handles conflicts with user prompts
- **Dependencies:** Requires valid credentials
- **Value:** Sync journal between CLI and web app

**Search:** `rg "logSyncAtris" commands/log-sync.js`

## Feature: Site Deploy (`atris site deploy`)

**Purpose:** Publish a static web folder or a Node server at a named `atris.ai` address.

- **Routing and help:** `commands/site.js` sends `deploy` to `commands/site-deploy.js`. Unbound folders need `--account`. Live publish needs `--yes`; `--dry-run` and help stay write-free.
- **Static lane:** Creates the site row, registers its custom domain, then uploads supported files as bare-list batches accepted by the Atris backend.
- **Fullstack lane:** `--fullstack` validates the package start script, mirrors source into a private GitHub repository from a scratch checkout, creates or reuses a Render Node service, waits for its deploy, and wires its Render host through the Atris site row.
- **Regression:** `test/site-deploy.test.js` covers validation, dry runs, `--yes` refuse, static uploads, Render setup, proxy fallback, and domain registration. Unbound CLI refuse plus `--yes` is in `test/dogfood-unbound-live-writes.test.js`.

**Search:** `rg "fullstack|registerSubdomain|createSite|uploadPages" commands/site-deploy.js test/site-deploy.test.js`

## Feature: Site Publish (`atris site publish`)

- **Docs:** `docs/site-publish.md`: flags, file handling, CSP profiles, recipes, exit codes, and troubleshooting.
- **Routing and help:** `commands/site.js` sends `publish` to `lib/site-publish.js` and documents both site upload paths.
- **Atomic publish:** Walks any static web folder, enforces the hosted page limits, maps text and binary content, and posts one publish body to `/api/sites/{slug}/publish`.
- **Build lane:** `--build` runs the package build script and publishes the first existing `dist`, `build`, or `out` directory.
- **Regression:** `test/site-publish.test.js` covers file mapping, normalized paths, both upload limits, request shape, and unverified publish failure.

**Search:** `rg "collectPages|claim_subdomain|csp_profile|site is not live" lib/site-publish.js test/site-publish.test.js`

## Revision reports across out-of-order commit dates

Business CLI test runner: `test/helpers/business-cli.js:8` keeps the actual asynchronous child, direct caller environment, fifteen-second SIGTERM timeout and original error/close behavior. Deploy, operations and ship tests retain their local HTTP servers, fixture credentials and every original case. Check: `node --test test/business-deploy.test.js test/business-ops.test.js test/business-ship.test.js`.

Global skill destinations: `commands/sync.js:812` resolves the existing `stateHome` policy at `lib/state-home.js:97` before checking global Claude and Codex skill directories. `test/sync-skills-state-home.test.js:104` exercises actual init with an owned protected-home stand-in; the same file preserves normal sync, explicit temporary HOME, real-home opt-out, project links and custom hooks. Check: `node --test test/sync-skills-state-home.test.js test/update-dry-run.test.js test/update-preserves-team.test.js test/sync-all.test.js test/init-non-interactive.test.js`.

## Feature: Night shift, morning receipt, and join as agent (`atris night`, `atris morning`, `atris join --name`)

**Purpose:** An owner gives an agent a goal for tonight with a dollar cap, reads one receipt in the morning, and makes the current session a named agent on a home computer.

- **Night:** `commands/night.js:120` `nightCommand` refuses a cap of $0 or less before any call, then posts `/night-shift` and prints one line. `watchShift` at `commands/night.js:90` polls `/night-shift/{id}` every 60 seconds and stops at capped, done, or failed.
- **Morning:** `commands/morning.js:28` `morningCommand` reads `/morning` and prints a short card (score and change from the night before, up to three learned lines, lessons used, spend, what was saved); a 404 or no receipt prints "No night shift finished yet." `--full` adds the old receipt text, `--json` prints the data as is and saves nothing.
- **Morning saves:** `lib/night-learned.js:138` `saveLearned` writes the night's learned lines into the project's `learned.md` (in its atris folder; newest twelve, first line labels them hints) and, through `writeLesson`, `lessons.md`; `nightFromMorning` at `lib/night-learned.js:52` cleans the text first (`cleanText` in `lib/night-shift.js`); the same night id and text is never written twice; `--no-save` skips; no `atris/` folder prints one line. `learned.md` is in the brain's optional load list (`OPTIONAL_LOAD_ORDER_FILES` in `commands/brain.js`).
- **Join:** `bin/atris.js:3619` sends `atris join` with `--name` to `commands/join.js:94` `joinAgentCommand` (posts `/join-as-agent`); without `--name` it stays the invite claim in `commands/social.js`. `storeJoinedAgent` at `commands/join.js:59` keeps the key in the `atris login --agent` slot (`agent_token`) and the agent as `joined_agent`. With no `--mission`, `purposeFromFolder` at `commands/join.js:84` reads the North Star in `atris/team/<name>/MISSION.md`, shows it, and sends it as the mission.
- **Default agent:** `resolveTarget` at `lib/night-shift.js:70` makes night and morning act for the joined agent unless `--agent` or another `--business` is given.
- **Regression:** `test/night-morning-join.test.js` covers the cap refusal, the shift line, watch events, morning and no-shift, and join storing the key; `test/morning-bring-home.test.js` covers the card, the saved files, untrusted text, the brain load list, and the folder mission.

**Search:** `rg "night-shift|night-learned|join-as-agent|joined_agent|/morning" commands lib test/night-morning-join.test.js test/morning-bring-home.test.js`
