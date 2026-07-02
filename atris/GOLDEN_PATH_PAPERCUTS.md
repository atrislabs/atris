# Golden Path Papercuts

## 2026-07-02 - onboarding zero-knowledge pass in atris-cli

### Papercut: mission ids are not portable across sibling workspaces and nothing says so

- Command: `atris mission status mission-2026-07-02-golden-path-a-zero-knowledge-ffc7515f`
- CLI output from the wrong workspace: `Mission "mission-2026-07-02-golden-path-a-zero-knowledge-ffc7515f" not found.`
- Why it blocks a fresh operator: the mission can exist in a sibling checkout, but the CLI used to stop without saying where to go.
- Repair tasks:
  - `CLI-802` - Golden path papercut fix: mission status should hint when an id belongs to another workspace.
  - `CLI-805` - Papercut: mission ids are not portable across workspaces and nothing says so.
- Fix status: in review for `CLI-802` and `CLI-805`; missing `mission status`, `mission tick`, and `mission run` lookups now point at the owning sibling workspace or git worktree, and full mission ids no longer fall through to an older local prefix match.

### Papercut: golden-path current task ordering points at pass 1e before pass 1a

- Command: `atris task current --tag golden-path --json`
- CLI output: selected `CLI-797`, "Golden path pass 1e...", even though open tasks `CLI-793` through `CLI-797` are titled pass 1a through pass 1e.
- Why it blocks a fresh operator: the CLI says "current" but appears to choose the end of the pass before the beginning, so the operator has to know ordering intent from outside the CLI.
- Repair task: `CLI-798` - Golden path papercut: task current should choose pass 1a before later golden-path pass steps or explain ordering.

### Papercut: the named golden-path papercut file is missing

- Command: `ls -l atris/GOLDEN_PATH_PAPERCUTS.md`
- CLI output: `ls: atris/GOLDEN_PATH_PAPERCUTS.md: No such file or directory`
- Why it blocks a fresh operator: `CLI-797` asks the operator to convert every papercut in this file, but the CLI does not say whether a missing file means no papercuts, a setup failure, or that the operator should create it.
- Repair task: `CLI-799` - Golden path papercut: CLI-797 should say what to do when atris/GOLDEN_PATH_PAPERCUTS.md is missing.

### Papercut: mission tick summary warning fires on plain recovery text

- Command: `atris mission tick mission-2026-07-02-golden-path-a-zero-knowledge-ffc7515f --verify "node --test test/mission-status.test.js" --summary "..."`
- CLI output: `Warning: add the why in plain words to this tick summary: what changed, what it buys or costs, and no flags or identifiers.`
- Why it blocks a fresh operator: the summary already explained what changed and why it helps, so the warning creates doubt without pointing to a concrete fix.
- Repair task: `CLI-803` - Golden path papercut: mission tick summary warning fires on plain operator-facing recovery text.
- Fix status: in review; mission tick summary warnings now fire only on machine-detectable flags, ids, or code identifiers, and the recovery-summary regression stays silent.

### Papercut: mission status says no verifier after an explicit behavior check ran

- Command: `atris mission status mission-2026-07-02-golden-path-a-zero-knowledge-ffc7515f`
- CLI output: `last tick: 27s ago (#2, ran, no verifier, layer: capabilities)` while the same status landing says `How I checked: I ran the behavior checks.`
- Why it blocks a fresh operator: the status card contradicts itself, so the operator cannot tell whether the proof was actually checked.
- Repair task: `CLI-804` - Golden path papercut: mission status says no verifier after a tick ran an explicit behavior check.
- Fix status: in review; mission status now derives verifier state from the latest receipt when mission state lacks `verifier_result`, and ad hoc verifier ticks show `verifier passed`.

### Papercut: npm install from tarball prints no next-step guidance

- Command: `npm install /path/to/atris-3.31.0.tgz` (local empty dir) and `npm install -g /path/to/atris-3.31.0.tgz` (clean HOME)
- CLI output: `added 1 package in 377ms` / `changed 1 package in 273ms` — nothing else
- Why it blocks a fresh operator: install succeeds but the CLI never says how to invoke `atris` (local install needs `npx atris`; global install needs npm global bin on PATH). The operator must already know npm conventions or run `atris --help` by guesswork.
- Repair task: `CLI-806` - Golden path papercut: npm install from tarball prints no next-step guidance (local or global).
- Fix attempt status: direct install-time guidance is blocked by npm's default behavior; npm hides dependency lifecycle script stdout/stderr for both local and global tarball installs, so a normal `postinstall` script still leaves the operator seeing only `added 1 package ...`.

### Papercut: npm hides install hooks, so the first visible Atris command must bridge the gap

- Command: `npm install /path/to/atris-3.31.0.tgz` after adding a harmless postinstall message.
- CLI output: still only `added 1 package in 331ms`; a control package that wrote to postinstall stderr also printed only `added 1 package in 128ms`.
- Why it blocks a fresh operator: the install surface cannot carry custom next-step guidance without abusing npm warnings, so the first visible `atris`/`npx atris` command needs to explain local vs global invocation and the next `init/status` move.
- Repair task: `CLI-808` - Golden path papercut: npm hides tarball install lifecycle output, so first visible command must bridge local/global next steps.
- Fix status: in review; top-level help and the fresh no-workspace prompt now show both global `atris init` and local `npx atris init`, with focused tests and a packaged tarball smoke.

### Papercut: packaged install crashes on mission tick

- Command: `npx atris mission tick <id> --summary "..."` (from a fresh local npm install of the packed tarball)
- CLI output: `ReferenceError: hasAgentJargon is not defined` at `commands/mission.js:101`
- Why it blocks a fresh operator: any consumer who installs from the tarball and tries to run a mission hits a hard crash instead of a tick receipt.
- Repair task: `CLI-807` - Golden path papercut: packaged install crashes on mission tick with hasAgentJargon is not defined.
- Reconfirmed: global `atris mission tick ...` hit the same crash while closing `CLI-809`; the fixed worktree binary was needed to record the receipt.

### Papercut: clean-tree instructions point at a missing worktree script

- Command: `python3 scripts/agent_worktree.py create --agent onboarding --task cli-808-first-visible-guidance --base origin/master`
- CLI output: `can't open file '/Users/keshavrao/arena/atris-cli/scripts/agent_worktree.py': [Errno 2] No such file or directory`
- Why it blocks a fresh operator: the repo-level clean-tree instructions tell agents to run a script that is not present in this checkout, so a consumer has to discover `atris worktree start` by guessing or asking for help.
- Repair task: `CLI-809` - Golden path papercut: clean-tree instructions point to scripts/agent_worktree.py, but the atris-cli checkout does not include that script or print the CLI worktree alternative.
- Fix status: in review; `scripts/agent_worktree.py create ...` now prints the canonical `atris worktree start ...` command and creates the isolated checkout, and the wrapper is included in npm pack.

### Papercut: whoami makes cloud login sound required for local task work

- Command: `atris whoami`
- CLI output: `Status: Not logged in` followed by `Run "atris login" to sign in.`
- Why it blocks a fresh operator: `atris task next` can still claim local work using the local task owner, and git has a separate author identity; `whoami` collapsed those into one cloud-login story.
- Repair task: `CLI-816` - Golden path: identity confusion. atris whoami says not logged in while task next claims as the git user.
- Fix status: in review; `whoami` now prints local task owner, git author, and optional cloud account status as separate sections.

### Papercut: init makes MAP.md feel like mandatory agent homework

- Command: `atris init`
- CLI output: `Created MAP.md placeholder`; today's journal added `T1: Generate MAP.md — scan codebase...`
- Why it blocks a fresh operator: the first workspace state implies the human must generate a navigation map before doing useful work, and that fake bootstrap task hijacks the first default command.
- Repair task: `CLI-815` - Golden path: init creates a stub MAP.md then asks you to generate MAP.md.
- Fix status: in review; init now writes a small starter map with first reads and detected project context, keeps the bootstrap backlog empty, and explains that MAP grows when real code paths are learned.

### Papercut: init ends in an open-ended prompt instead of one next command

- Command: `atris init`
- CLI output: after initialization, the command fell through to the context gatherer and asked `What are you trying to make easier right now...`
- Why it blocks a fresh operator: setup succeeded, but the last line was not a copy-pasteable next step, so the user had to decide whether to answer a prompt, run status, read docs, or start a task.
- Repair task: `CLI-812` - Golden path: atris init must end with one human next command, not agent MAP homework.
- Fix status: in review; `atris init` now stops after setup and ends with `cat atris/GETTING_STARTED.md`, with a regression asserting the final non-empty line.

### Papercut: setup advertises a separate guided first-time flow

- Command: `atris help` then `atris setup`
- CLI output: help advertised `setup - Guided first-time setup (login, pick business, pull)`, while the golden path already needs `atris init` as the one local setup front door.
- Why it blocks a fresh operator: two first-run commands split the path, and the setup flow can enter login/business prompts instead of finishing local workspace setup.
- Repair task: `CLI-811` - Golden path: atris setup hangs silently while help advertises it as guided first-time setup.
- Fix status: in review; top-level help now lists only `init` for setup, and `atris setup` is a compatibility alias for `atris init` with a regression proving it finishes locally without login prompts.

### Papercut: pass 2 is offered before pass 1 fixes have landed

- Command: `atris task list --tag golden-path`
- CLI output: `CLI-800` appeared as the next open golden-path item even though its title says `after pass 1 papercut fixes land`; the same task list still showed pass-1 fix rows in `review` and pass-1 walk rows still `open`.
- Why it blocks a fresh operator: the user is sent into a repeat pass that cannot truthfully validate the fixed product yet, because the prerequisite fixes are not accepted or landed in the runnable package.
- Repair task: `CLI-817` - Golden path papercut: pass 2 is offered before pass 1 fixes have landed.
- Fix status: delegated; pass 2 should be hidden, blocked, or explain the prerequisite until the required pass-1 rows are accepted/merged.

### Papercut: status and launchpad tell different next-move stories

- Command: `atris status` then `atris launchpad`
- CLI output: status showed queued TODO work, while launchpad could fall through to no clear next move when the task projection was missing or empty.
- Why it blocks a fresh operator: the two front doors disagree at the exact moment the user needs one copy-pasteable next command.
- Repair task: `CLI-814` - Golden path: atris status and atris launchpad disagree.
- Fix status: in review; launchpad now falls back to parsed `atris/TODO.md` when projection tasks are absent, and status prints the same selected next command from launchpad.

### Papercut: manual missions still ask terminal users for Codex-native handoff work

- Command: `atris mission run "<goal>" --runner manual`
- CLI output: manual runs could still route through visible-goal or task-spine next commands instead of a plain terminal recipe.
- Why it blocks a fresh operator: a non-Codex user cannot call native goal tools, so the mission loop needs a copy-pasteable "do one bounded step, then tick" path.
- Repair task: `CLI-813` - Golden path: mission loop dead-ends for non-Codex users on native create_goal.
- Fix status: in review; manual missions now print a per-tick recipe and `mission run <id>` returns `atris mission tick <id> --verify --summary "<what changed>"` when a verifier exists, while internal `--no-claude` behavior keeps working.

### Pass 2 scheduled

- Follow-up task: `CLI-800` - Golden path pass 2: rerun the fresh-laptop walk after pass 1 papercut fixes land.

### Papercut: autoland tick --help runs a live tick

- Command: `atris autoland tick --help`
- CLI output: `autoland tick: 3 reviews certified, 3 landed (CLI-816, CLI-805, CLI-815), 0 alarms, digest not due`
- Why it blocks a fresh operator: asking for help mutated task state and landed review rows, so a zero-knowledge user cannot safely discover how autoland works.
- Repair task: `CLI-818` - Golden path papercut: autoland tick --help runs a live tick.

### Papercut: first mission tick records a no-work receipt

- Command: `atris mission tick mission-2026-07-02-create-a-hello-note-in-this--1f7d79be`
- CLI output: `Changed: Create a hello note in this toy repo recorded tick 1.` and `Next: Keep running the mission.`
- Why it blocks a fresh operator: the mission goal was to create a hello note, but the first tick recorded bookkeeping instead of doing the work or pointing directly to the task setup command. The next line also said "Keep running" without a copy-pasteable command.
- Repair task: `CLI-819` - Golden path papercut: first mission tick records a no-work receipt.

### Papercut: task current-step --json floods the terminal

- Command: `atris task current-step --goal-id mission-2026-07-02-create-a-hello-note-in-this--1f7d79be --as validator --proof "..." --json`
- CLI output: 6,675 lines / about 67k tokens for a one-file toy mission, including repeated capability contracts and page payloads.
- Why it blocks a fresh operator: the command is printed as the next step, but its JSON output is too large to inspect, paste, or understand during a first-run flow.
- Repair task: `CLI-820` - Golden path papercut: task current-step --json floods the terminal.

### Papercut: filtered task next claims unrelated work

- Command: `atris task next --tag golden-path --as onboarding`
- CLI output: `next CLI-810 @onboarding`, but `CLI-810` is tagged `#loop`, not `#golden-path`.
- Why it blocks a fresh operator: a user asking for the next golden-path task can be moved onto unrelated loop work and mutate that unrelated task before they know the filter failed.
- Extra damage: `atris task claim CLI-810 --as auto-improver` then failed with `already_claimed (held by onboarding)`, so the CLI gave no printed way to release the accidental claim.
- Repair task: `CLI-821` - Golden path papercut: task next --tag must never claim a task outside that tag.

### Papercut: accidental task claims have no printed recovery command

- Command: `atris task claim CLI-810 --as auto-improver`
- CLI output: `claim failed: already_claimed (held by onboarding)`
- Why it blocks a fresh operator: after the CLI moved the user onto the wrong task, the user had no printed way to undo their own mistaken claim or reassign it to the intended owner.
- Repair task: `CLI-823` - Golden path papercut: accidental task claims need a printed recovery command.
