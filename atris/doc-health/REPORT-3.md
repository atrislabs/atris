# Tighter task summaries and complete piped JSON

## Changes

- `lib/task-db.js`: Backlog keeps ID, title capped at 140 characters, and tags. In Progress keeps ID, a 140-character title, owner, and a 40-character verify preview. Review keeps ID, a 140-character title, owner, and one approval line capped at 160 characters. Completed keeps ID and a 100-character title, still capped at eight rows. Truncated titles and approval lines end with an ellipsis inside the limit. Full mode retains the old detailed rendering. Database records and task show are unchanged.
- `lib/todo-fallback.js`: A compact-format marker distinguishes owner-free rows from legacy rows, preserving middle dots in titles. Even boards with only backlog or completed rows still trigger lookup of original titles and full commands from existing task state.
- `bin/atris.js`: Document health and doctor set process.exitCode on success and failure, allowing stdout and stderr to drain naturally.
- `test/doc-health.test.js`, `test/todo-compact.test.js`, `test/commands.test.js`, `test/workflow-delegation.test.js`: Real piped JSON regression with 40 members and 400 lookup questions, lane limits, original-data preservation, and updated row assertions.
- `atris/MAP.md`: Updated navigation and behavior descriptions.

## Backend measurement

Executed in `/Users/keshavrao/arena/atrisos-backend`:

```sh
node /Users/keshavrao/arena/.agent-worktrees/atris-cli/doc-health-boot-20260915/bin/atris.js task render
wc -c atris/TODO.md
```

Both exited 0. Exact output:

```text
rendered TODO.md -> /Users/keshavrao/arena/atrisos-backend/atris/TODO.md
Backlog: 42; In Progress: 25; Review: 35; Blocked: empty; Done saved: 30
   17759 atris/TODO.md
```

The generated file contains 17,639 characters and 17,759 UTF-8 bytes, both below 18,000. The live snapshot has 110 displayed rows instead of the brief's older 109-row snapshot. Full and compact renderings of the same saved task state both contain 42 Backlog, 25 In Progress, 35 Review, zero Blocked, and eight Completed rows. No tasks were removed. The requested backend render updated its TODO file; it is outside this commit.

## Verification

Command: `node --test test/task-explanation.test.js test/workflow-delegation.test.js test/autopilot-command.test.js test/autopilot-plan-review.test.js`

Exit: 0.

```text
ℹ tests 57
ℹ suites 0
ℹ pass 57
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1650.105458
```

Command: `node --test test/todo-sections.test.js test/brain-count-todo-items.test.js`

Exit: 0.

```text
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 68.571792
```

Required command: `node --test test/doc-health.test.js test/todo-compact.test.js test/commands.test.js`

Exit: 0. Exact summary:

```text
ℹ tests 460
ℹ suites 0
ℹ pass 460
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 203790.384958
```

Whitespace check: `git diff --check`, exit 0, no output.

Proof moved to Review with `node bin/atris.js task ready DHB-2 --verify "node --test test/doc-health.test.js test/todo-compact.test.js"`; verification exited 0. Receipt: `atris/runs/2026-09-16-task-dhb-2-2026-09-16T18-37-48-766Z.json`. No task acceptance, push, or pull request was performed. The unrelated generated local TODO refresh was discarded.
