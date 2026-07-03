# Golden Path Papercuts

### Papercut: mission ids are not portable across workspaces and nothing says so

- Found: 2026-07-02
- Task: CLI-805
- Evidence: A zero-knowledge agent ran the golden-path mission id from the backend workspace and Atris could not say that the mission lived in `/Users/keshavrao/arena/atris-cli`.
- Why it hurts: a user can paste a real mission id in the wrong folder and get a dead end or be routed toward unrelated local work instead of being told where to go.
- Desired fix: when mission status/tick/run cannot find an id locally, the CLI scans sibling workspaces and prints the exact workspace path to `cd` into; it must not redirect to a different local mission.

### Papercut: global npm install still prints no first command

- Found: 2026-07-02
- Task: CLI-827
- Evidence: In a clean temp HOME and isolated npm prefix, `npm install -g atris-3.32.0.tgz` printed only `added 1 package in 256ms`.
- Why it hurts: a zero-knowledge user has no printed next command after install, so the walk still depends on knowing to try `atris` or `atris init`.
- Desired fix: fresh tarball install output, or the unavoidable first visible command after install, gives one copy-paste next command.

### Papercut: init prompt has no non-interactive continuation command

- Found: 2026-07-02
- Task: CLI-828
- Evidence: In a clean toy repo, `atris init` exited 0 after printing `Answer in one sentence` and a `>` prompt, but did not print a command to continue when stdin was not interactive.
- Why it hurts: the walk depends on knowing how to answer or rerun the context gatherer; the CLI output does not provide a copy-paste next step.
- Desired fix: non-interactive `atris init` ends with one runnable next command, or detects that no TTY is available and prints exactly how to answer later.

### Papercut: mission tick help is parsed as a mission id

- Found: 2026-07-02
- Task: CLI-829
- Evidence: `atris mission tick --help` printed `Mission "--help" not found.` instead of read-only usage for the tick command.
- Why it hurts: when an operator needs to learn how to attach or verify a mission tick, the obvious help command becomes a dead end.
- Desired fix: `atris mission tick --help` prints usage without requiring a mission id or mutating mission state, with a regression.

### Papercut: mission current-step can submit bookkeeping receipts as full mission proof

- Found: 2026-07-02
- Task: CLI-830
- Evidence: `atris mission status` printed `atris task current-step --goal-id ... --proof "<proof>" --json`; using the latest mission receipt moved `CLI-801` back to Review even though that receipt only proved review-row bookkeeping, not the full fresh install -> init -> mission -> self-landed task pass.
- Why it hurts: a zero-knowledge operator can follow the printed next command and accidentally submit weak proof for the mission, recreating the exact rework loop the reviewer already rejected.
- Desired fix: mission status/current-step should not suggest or accept a generic/latest receipt for mission XP completion while golden-path fixes are still in review or human-accept waiting; it should print the missing prerequisite or require an explicit zero-papercut end-to-end receipt, with regression.

### Papercut: scoped task next escapes to unrelated Endgame work

- Found: 2026-07-02
- Task: CLI-833
- Evidence: `atris task next --tag golden-path --as onboarding --json` returned `human_accept_waiting` for `CLI-830`, but also included `next_agent_action.task_seed` for an unrelated `runner` task.
- Why it hurts: a zero-knowledge operator following a golden-path lane can get sent into unrelated Endgame work instead of seeing that scoped golden-path work is blocked on human approval or another owner.
- Desired fix: scoped `task next` and current surfaces should never suggest unrelated fallback work outside the requested tag or goal; they should print the scoped blocker or say no scoped agent-actionable work is available, with regression.

### Papercut: worktree ship help is blocked by dirty-state validation

- Found: 2026-07-02
- Task: CLI-834
- Evidence: In a dirty isolated worktree, `atris worktree ship --help` printed `blocked: --message is required when there are local changes to commit` instead of usage.
- Why it hurts: when an operator reaches the final ship step and asks for help, the CLI withholds the command shape unless they already know the required flags.
- Desired fix: `atris worktree ship --help` prints read-only usage without requiring `--message`, `--verify`, clean state, or mutating the worktree, with regression.

### Papercut: mission goal recovery asks for an impossible native goal create

- Found: 2026-07-02
- Task: CLI-837
- Evidence: After the golden-path goal entered Codex `usageLimited` state, `atris mission tick` printed a recovery asking to call `create_goal(...)`; Codex refused because the same thread still had an unfinished goal.
- Why it hurts: a zero-knowledge operator can follow the printed recovery exactly and still be stuck, with no instruction to re-acknowledge, resume, or reset the existing matching goal.
- Desired fix: when the native goal already exists but is usage-limited/paused, mission tick should print the valid recovery path for that state instead of telling the operator to create a duplicate goal.
