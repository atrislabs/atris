# Workspace docs and maps

Init, update, workflow, wiki, skills, doc health, the map tools and the hourly map note fold. Exact `file:line` refs and search shortcuts. Back to [MAP-NOTES.md](../MAP-NOTES.md).

## Quick Reference Index

| Route | Paths | Purpose |
| --- | --- | --- |
| Document health | `commands/doc-health.js`, `lib/map-refs.js`, `lib/recall-exam.js`, `test/recall-exam.test.js`, `atris/doc-health/recall-seen.jsonl`, `test/doc-health.test.js`, `atris/doc-health/questions.jsonl` | Boot size, map coverage, lookup hops, stale features and members, near duplicates, and weighted score (boot earns full credit through 80,000 chars, zero at 200,000). `lib/map-refs.js` checks every backticked `path:N` ref in this map against the code, using the identifier written right next to it: right, moved, unclear, or gone; the map score is the existing-path share times the right-ref share. `atris doc-health --fix-refs` rewrites only moved refs (ranges keep their width, clamped to the last line) and lists the rest by map line. computeDocHealth(root) supplies the guarded startup docs row in bin/atris.js:1766 without a subprocess; one-hop questions avoid document reads and score-only member scans stop at the first recent log. Inactive member frontmatter is excluded from freshness; retired/superseded features are not stale; _archive and _templates never count as features. Uses `commands/brain.js:140` readText and `lib/mission-root.js:24` resolveWorkspaceRoot; registered beside doctor in `bin/atris.js:2757`, with both commands draining piped output through process.exitCode and `lib/known-commands.js`. Recall exam: `atris doc-health --recall <file>` runs `lib/recall-exam.js` runRecallExam, a reader that starts from the boot files and opens the linked markdown file whose line best matches the question until an opened file holds the needle; it reports found, files opened, wrong opens and tokens read, and `--summary` keeps a held-out set unprinted. |

## Search shortcuts: Core CLI logic

```bash
rg "isNonInteractive|isForcedNonInteractive|ATRIS_NONINTERACTIVE|refuseHeadlessUnless|isHelpToken|argsWantHelp|rejectUnsupportedJson|whoami --json|PROMPT ONLY|ACTION TAKEN|seedInitTaskPlane|importJournalFile|join --help|signup help|avail --help|helpOnly|write start help|showStartHelp|start --help|task accept --help|task claim --help|task ready --help|task step --help|task next --help|task show --help" lib/noninteractive.js lib/workspace-scaffold.js commands/auth.js commands/log.js commands/now.js commands/skill.js commands/member.js commands/version.js commands/workflow.js commands/wiki.js commands/task.js commands/social.js commands/signup.js commands/avail.js commands/spaceship.js commands/dream.js commands/scout.js commands/interview.js commands/autopilot-front.js commands/write.js bin/atris.js test/dogfood-p0.test.js test/dogfood-p0-safety.test.js test/signup.test.js test/write.test.js test/dogfood-pass4.test.js test/task-subcommand-help.test.js  # Dogfood P0 + pass-4 safety: help on start/voice words is usage before NL; noninteractive guard; help-before-network; headless autopilot --json status; JSON contracts; task accept/claim/ready/step/next/show --help is usage only
rg "starterMembers|team members ready|firstMissionCommand|packed golden path|printedAtrisArgs|golden path e2e|what someone can do now|--minimal|mapStubFromTree" commands/init.js bin/atris.js commands/task.js test/init-non-interactive.test.js test/golden-path-e2e.test.js test/repo-shape.test.js test/dogfood-papercuts.test.js atris/team/customer-lead atris/GOLDEN_PATH_PAPERCUTS.md  # Quiet first-run output plus packed-install zero-knowledge contract: six-member starter team, init --minimal lean scaffold, ready-on-init mission, autoland, durable papercut status; printedAtrisArgs (test/golden-path-e2e.test.js:112) matches Next/next labels; packed path uses its own ATRIS_TASKS_DB, names the last commit already here, follows printed `atris do`, then ready/autoland
rg "function planAtris" commands/workflow.js   # Plan command (line 475): empty folder reuses buildFirstMinute({ fresh: true }) and freshMinuteJson (same two spoken lines and --json next as bare atris); leftover words after plan stay a request; factory banner and navigator paste stay on --prompt/--verbose/--full or a direct request; missing navigator spec after init --minimal does not send you back to init
rg "function doAtris" commands/workflow.js     # Do command (line 868): empty folder reuses buildFirstMinute / freshMinuteJson like bare atris; files already here start first-talk via startFirstTalk / visibleWorkTitle (ready + already claimed as the speaker); after the work is yours, next is `atris task ready <id> --verify "git diff --check"` so keep-working is not a do loop; files only already here (not yet yours) still say next is atris do; PERSONA head stays first-minute after init; executor paste stays on --prompt/--verbose/--full; missing executor spec after init --minimal does not send you back to init
rg "function reviewAtris|renderReviewMinute" commands/workflow.js test/workflow-command.test.js  # Review command: empty folder reuses speakFirstMinute / isFreshWorkspace (same two spoken lines and --json next as bare atris); after init, claim/ready/accept next matches bare atris, certified -> accept, empty desk stays "nothing is waiting"; --all/--limit/--group-by keep the queue; --verbose legacy validator prompt; headless never prompts
rg "Confidence Gate|confidenceGatePrompt" commands/workflow.js test/confidence-gate.test.js  # Plan/do/review loophole gate prompt + regression
```

## Search shortcuts: Modular commands

```bash
rg "snapshotBeforeInit|commitInitFiles|hasCommits|setup saved to git|--no-commit" commands/init.js lib/init-commit.js test/init-commits-for-members.test.js  # Init setup commit (brand new repos only): `lib/init-commit.js:48` snapshots already-dirty paths before init writes, `lib/init-commit.js:56` commits only the new paths (skips *.local.* config, falls back to the Atris identity when git has none); member copies cut from history then carry the team, map, and task list
rg "initAtris|upsertAtrisClaudeBootBlock|openingLinesForRoot|upsertAgentsOpeningLines|upsertClaudeVoiceHook|upsertCursorVoiceCard|upsertAgentVoiceCard|--minimal|--with-adapters|--with-skills" commands/init.js lib/claude-boot-block.js lib/opening-lines.js lib/voice-card.js test/claude-boot-block.test.js test/init-four-lines.test.js test/voice-card.test.js test/dogfood-papercuts.test.js test/init-non-interactive.test.js  # Init command, voice-card doors, operating-rules bullets copied from atris.md into AGENTS.md and the CLAUDE.md block, and --minimal/--with-adapters/--with-skills gates; --minimal writes lessons.md and does not create INTUITION.md
rg "cleanAtris|cleanResultPayload|clean --dry-run --json" commands/clean.js test/commands-1.test.js           # Clean command text/json output
rg "showSearchHelp|searchJournal|search help flags|--memory-only|scanSource|scanMap" commands/search.js bin/atris.js test/commands-1.test.js test/dogfood-pass2-t1-t5.test.js # Search hits source + MAP + wiki; --memory-only keeps features/team/wiki/logs only
rg "skillColor|skillList|NO_COLOR" commands/skill.js test/dogfood-papercuts.test.js  # skill list ANSI gated on TTY / NO_COLOR
rg "installCommand|ensureWorkspaceBrain|workspaceBrainPresent|command === 'install'|command === 'workspace'" commands/install.js lib/workspace-scaffold.js commands/init.js bin/atris.js lib/known-commands.js test/member-scaffold.test.js  # Install verbs: `atris member install <slug>` writes the nine-piece MEMBER bundle; `atris install` / `atris workspace install` writes missing atris/ brain files from the init scaffold and never overwrites
rg "wikiCommand|printWikiHelp|wiki help paths" commands/wiki.js test/commands-1.test.js  # Wiki ingest/query/lint/local memory + non-mutating help
```

## Search shortcuts: Documentation

```bash
rg "Agent Contract|Universal Agent|OpenClaw" AGENTS.md .cursorrules commands/init.js atris/CLAUDE.md  # generated agent onboarding contract
```

## Feature: Project Initialization (`atris init`)

**Purpose:** Creates atris/ folder structure with placeholders, wiki scaffold, and auto-detects project type

- **Entry point:** `commands/init.js` (initAtris function)
- **Brain install:** `atris install` / `atris workspace install` (`commands/install.js`, `lib/workspace-scaffold.js`) writes missing MAP.md, TODO.md, now.md, atris.md, logs/ dated journal, wiki/index.md, and team/ without overwriting
- **Project Detection:** `commands/init.js:12-166` (detectProjectContext)
- **Pattern Injection:** `commands/init.js:168-252` (injectProjectPatterns)
- **Creates:**
- `atris/` folder
- `atris/wiki/` scaffold with `wiki.md`, `index.md`, `log.md`, `STATUS.md`
- `atris/team/` with navigator, executor, validator, mission-lead, improver, and customer-lead; later member creation uses `atris member create <name>`
- `atris/features/` subfolder with README template
- `GETTING_STARTED.md`, `MAP.md`, `TODO.md` placeholders
- `.project-profile.json` (project detection metadata)
- Copies `atris.md` from package
- **Project Detection:**
- Supports: Node.js, Python, Ruby/Rails, Go, Rust, Java, PHP, Elixir, knowledge bases
- Auto-detects: Framework (React, Vue, Django, Rails, etc.), test commands, file structure
- Injects: Project-native instructions into agent specs
- **v1.9.6 update:** Now auto-creates `atris/features/` directory with README template

**Search:** `rg "detectProjectContext|injectProjectPatterns" commands/init.js`

## Feature: Workspace Cleanup (`atris clean`)

**Purpose:** Housekeeping: find stale tasks, heal broken refs, detect stale wiki pages, archive old journals

- **Dispatch:** `bin/atris.js:1931` handles `--help`, `--dry-run`, and `--json` before routing to `cleanAtris`
- **Help:** `bin/atris.js:1169` (`showCleanHelp`) prints usage without touching workspace state
- **Entry point:** `commands/clean.js:14` (cleanAtris function)
- **JSON payload:** `commands/clean.js:266` (`cleanResultPayload`) returns machine-readable stale tasks, MAP refs, journals, sections, stale pages, dead code, and manual actions without text chrome
- **Helpers:**
- `findStaleTasks()`: Find tasks claimed >3 days ago
- `healBrokenMapRefs()`: Validate + auto-fix MAP.md file:line refs (range + drift detection)
- `findStalePages()` (`commands/clean.js:748`): Scan atris/ for markdown with `last_compiled` frontmatter, compare when each source last changed
- `checkPageStaleness()` (`commands/clean.js:821`): Parse frontmatter, check each source vs compiled date; `contentChangedAt()` uses the last commit date for files git holds unchanged, so a checkout touching mtimes is not staleness (`test/clean-stale-pages.test.js`). Plain-language sources and web links name no file and are skipped (`looksLikePath`); a relative source is found from the repo root, the page folder, or any folder between (`resolveSource`, `test/staleness-parser.test.js`)
- dead-code report: step 6 in `cleanAtris` calls slop's `findDeadCode` (report-only, feeds manual actions); a file guarded by `require.main === module` counts as an entrypoint, so a server started with `node lib/x.js` is never called test-only
- `archiveOldJournals()`: Move journals >30 days to archive/
- `cleanEmptySections()`: Remove placeholder sections
- **Output:**
- Stale task warnings
- Broken MAP.md ref list (healed + unhealable)
- Stale wiki page list (source newer than last_compiled)
- Archive count, cleaned section count
- **Flags:** `--dry-run` / `-n` to preview without changes; `--json` for automation-readable health output
- **Regression:** `test/commands-6.test.js:1910-1951` covers missing-workspace JSON, help, and `clean --dry-run --json`
- **Value:** Keep workspace clean, trust in MAP.md, detect knowledge rot

**Search:** `rg "showCleanHelp|command === 'clean'|cleanAtris|cleanResultPayload|findStalePages|looksLikePath|resolveSource|clean --dry-run --json" bin/atris.js commands/clean.js test/commands-1.test.js`

## Feature: Wiki (`atris ingest`, `atris query`, `atris lint`, `atris wiki`)

**Purpose:** Local-first project memory with raw evidence in `atris/context/` and compiled memory in `atris/wiki/`, with `--cloud` opt-in for business workspaces and session-start activation wiring

- **Entry points:** `bin/atris.js` (help text, known commands, wiki + alias routing)
- **Handlers:** `commands/wiki.js` (ingest/query/lint/search/log), `lib/wiki.js` (scaffold + prompt builders), `commands/init.js` (wiki bootstrap), `commands/activate.js` (wiki status load)
- **Help:** `commands/wiki.js:172-174` (`hasHelpFlag`/`printWikiHelp`) and `commands/wiki.js:408-412` short-circuit wiki help before ingest/query/lint workers can scaffold state
- **Regression:** `test/commands-2.test.js:2197-2219` covers `ingest|query|lint --help`, `wiki --help`, and `wiki ingest --help` without `atris/` or `$HOME/.atris` creation
- **How it works:**
- `atris ingest <path>` scaffolds `atris/wiki/`, stages local evidence into `atris/context/_ingest/`, writes a manifest receipt, refreshes wiki STATUS/log, and prints the local ingest prompt against the staged source
- `atris query "question"` prints a local wiki query prompt
- `atris lint` prints a local wiki lint prompt
- `atris init` now scaffolds `atris/wiki/` in every new workspace
- `atris activate` now reads `atris/wiki/STATUS.md`
- `atris wiki ingest|query|lint --cloud` routes the same prompt builders through business chat
- `atris wiki search <term>` searches local `atris/wiki/index.md`
- `atris wiki log [N]` shows recent `atris/wiki/log.md` activity
- `atris wiki consolidate` prints a local pruning prompt and records per-surface counts in `.atris/state/wiki.metabolism.json`; lint flags over-budget surfaces and growth of 10 or more entries, while boot and `atris clean` print one defensive pruning nudge when those findings exist
- `atris wiki loop` routes to the same local upkeep analysis as `atris loop`
- `atris pull --only wiki` / `atris push --only wiki` normalize to `atris/wiki/`
- **Wiki structure:**
- `atris/context/`
- `atris/context/_ingest/`
- `atris/wiki/wiki.md`
- `atris/wiki/index.md`
- `atris/wiki/log.md`
- `atris/wiki/STATUS.md`
- `atris/wiki/people/`
- `atris/wiki/systems/`
- `atris/wiki/concepts/`
- `atris/wiki/briefs/`
- **Value:** Makes project memory local by default instead of forcing the cloud path first

**Search:** `rg "wikiCommand|printWikiHelp|wikiIngest|buildIngestPrompt|wikiMetabolismNudge|normalizeWikiOnlyPrefix|ensureWikiScaffold|wiki help paths" commands/wiki.js commands/clean.js lib/wiki.js commands/init.js bin/atris.js test/commands-1.test.js test/wiki-metabolism-warning.test.js`

## Concern: Skills

**Files:**

- `atris/skills/atris/SKILL.md`: Atris workflow skill
- `atris/skills/writing/SKILL.md`: Writing skill
- `atris/skills/email-agent/SKILL.md`: Gmail integration v1.1.0 (inbox, send, archive, drafts CRUD)
- `atris/skills/calendar/SKILL.md`: Google Calendar integration v1.0.0 (events/today, OAuth)
- `atris/skills/drive/SKILL.md`: Google Drive + Sheets integration v1.0.0 (files, sheets CRUD)
- `atris/skills/README.md`: Skills pattern + Claude symlink instructions
- `atris/skills/copy-editor/SKILL.md`: Repo-owned anti-slop copy editor skill, including memo-specific slop gate
- `atris/skills/clean-copy/SKILL.md`: Repo-owned skill for cutting interface copy that should not exist, before any rewording
- `commands/skill.js` and `test/skill-audit-codeblocks.test.js` - Skill audit checks and code-block XML regression coverage
- `atris skill eval <skill-path>` routes through `commands/skill-eval.js`, runs an independent bench engine in a neutral temporary directory, and appends an `atris.skill_eval.v1` row to `.atris/state/scorecards.jsonl`
- `lib/skill-eval-gate.js` finds changed `SKILL.md` files and requires a newer passing receipt whose judge differs from the worker model; `lib/auto-accept-certified.js` runs it through the shared landing hygiene gate
- `test/skill-eval-gate.test.js` covers missing, stale, valid, unrelated-diff, and same-worker receipt behavior
- `commands/skill.js:668-719` - `atris skill create <customer>/<skill>` scaffolds customer skills under `atris/customers/<customer>/skills/`
- `commands/skill.js:967-982` - `atris skill --help` prints usage and exits 0; flag-shaped create names do not make a junk folder
- `commands/plugin.js:176`: `buildPlugin` packages universal `atris/skills` into `atris-workspace.plugin`
- `commands/plugin.js:452-464` - `atris plugin --help` prints usage and exits 0
- `commands/plugin.js:336`: `publishPlugin` syncs universal skills to a marketplace repo; no customer-specific publish path yet
- `atris/features/customer-skill-zones/`: parked feature notes for customer skill scaffold vs private plugin publishing

**Use:** Codex skills for Atris workflow and writing guidance; integration skills for Gmail, Calendar, Drive via AtrisOS API. Claude integration uses `.claude/skills` symlinks (see `atris/skills/README.md`). Customer-specific skills can be scaffolded locally, but customer-specific plugin build/publish is intentionally not implemented.

**Backend:** All integration APIs live at `atrisos-backend/backend/routers/integrations/` (gmail.py, google_calendar.py, google_drive.py).

**Search:** `rg "customer|customers|--customer|skill create|plugin build|plugin publish" README.md commands/skill.js commands/plugin.js bin/atris.js atris/MAP.md`

## Concern: Output Quality Policies

- `lib/dispatch-scout.js:87-175,237-370`, `lib/fleet.js:625-660,2443-2556,2654-2825` - optional pre-builder scout shared by fleet and engine dispatch: seed tracked candidates from MAP plus task-title keywords, ask Haiku once through the read-only plan lane for 45 seconds, verify excerpts and drifted lines against the pinned checkout, drop packs under two surviving hits or over 4KB, then append one commit-labeled block after lessons and taste; failure leaves the original brief unchanged. `commands/scout.js:1-147` remains the separate human command. Regressions: `test/dispatch-scout.test.js:112-308`; `test/one-lap-runtime.test.js:180-211` keeps the fake Haiku scout separate from independent-validator accounting.

## Concern: Skill Creation (external tools)

**Scripts:**

- `~/.codex/skills/.system/skill-creator/scripts/init_skill.py`
- `~/.codex/skills/.system/skill-creator/scripts/package_skill.py`

**Use:** Initialize and package Codex skills.

---

## ⭐ `atris.md` (470 lines, 23.3KB)

**Why critical:** Source of truth for AI agent behavior

**Structure:**

- Phase 1 (lines 11-43): MAP.md generation
- Phase 2 (lines 47-125): Agent specs (navigator, executor, validator)
- Phase 3 (lines 129-195): TODO.md generation
- Phase 4 (lines 184-211): Activation & validation
- Phase 5 (lines 260-467): Daily workflow + journal protocol
- Phase 5.2 (lines 469+): atris protocol (visualize → approve → build)

**Version:** v2.5.4

**Impact:** Changes propagate to all users on `atris update`

**Search:** `rg "## Phase" atris.md`

## ⭐ `commands/init.js` (1101 lines)

**Why critical:** First-run experience, project detection

**Key functions:**

- `detectProjectContext()` (lines 11-165): Auto-detect project type
- `injectProjectPatterns()` (lines 173-252): Inject project-native instructions
- `initAtris()` (lines 254-1099): Create folder structure

**Impact:** Onboarding UX, sets user expectations

**Search:** `rg "detectProjectContext|initAtris" commands/init.js`

## Hourly map note fold

rg "foldMapNotesOnMain|foldNotesText|foldDue|map-notes.d|map_fold|last_map_fold_at" lib/member-map-fold.js commands/autoland.js test/member-map-fold.test.js # Member changes save map notes as their own file under atris/refs/map-notes.d/ (open with a "## " heading to join that section) instead of editing this file; once an hour the autoland tick folds them into MAP-NOTES.md on main and removes them in one pushed commit, no checkout touched. Off switch: policy map_fold:false. Regression: test/member-map-fold.test.js
rg "foldTargets|MEMBER_NOTES_FILE|areaNoteDocs|MAP_NOTES_DIR|mapNoteFiles|isMapFile" lib/member-map-fold.js lib/map-refs.js commands/clean.js lib/zen-apply.js lib/member-map-inbox.js test/map-notes-split.test.js # Split deep map: `atris/refs/MAP-NOTES.md` is a one-screen index over one note per area in `atris/refs/map/`. `lib/map-refs.js` existingMapDocs lists the index and every area note, so doc-health, fix-refs, verify, search and dispatch scout read them all; `atris clean` heals refs in each; the hourly fold puts a drop into the area note that already has its heading and any other drop into `atris/refs/map/member-notes.md`; a workspace with no area notes folds into MAP-NOTES.md as before.
rg "mapNotesExcerpt|gatherTerritoryContext|collectWorkspaceContext" lib/map-refs.js commands/unknowns.js commands/visualize.js test/map-notes-split.test.js # Prompt excerpts from the deep map: mapNotesExcerpt ranks area notes by how many query words they match and fills the budget from the best note first; `atris unknowns` uses it for the problem text and falls back to the top of MAP-NOTES.md, `atris visualize` uses it for the prompt.
rg "ensureProjectTasteFile|PROJECT_TASTE_FILE" lib/taste-notes.js commands/init.js commands/sync.js test/taste-personal-files.test.js # Taste files: the shipped `atris/skills/taste/` only says how taste works; the taste itself lives in the project's own TASTE.md (in its atris/taste folder) and the person `~/.atris/taste/TASTE.md`. Init and update write the project starter only when missing; sync touches neither.
