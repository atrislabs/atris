# Keep engine-dependent tests from launching the operator's engine

The isolation plan now has a proven cause: an inherited engine setting selects
Codex before the lesson test's Claude-only interception. The real command
builder comparison passed, exit 0; full verification is recorded below.

## Verdict

Proceed-with-changes on isolating engine selection in the lesson and command
format tests. The single failure mode is an unexpected engine escaping the test
interception and launching real model work.

Pin and restore all seven existing runner environment keys for each lesson
fixture, including asynchronous completion. Select Claude explicitly for that
fixture. Its command interceptor must throw on an unexpected model command,
rather than fall through to the real shell. Preserve ordinary file operations
and the git fixture. Wrap the default-format tests with the existing
runner environment helper. Keep runtime selection and production code unchanged.

Require the same tests to pass when their parent selects Codex and supplies a
custom runner binary and template. Assert no model subprocess starts. Keep the
existing lesson-result assertions, so isolation cannot mask a broken lesson
filter. This is a plan verdict, not permission to merge an implementation.

## Boundary and evidence

```text
inherited engine setting -> test-owned selection -> intercepted model command
                                               -> lesson assertions
unexpected model command -> fail before launch
```

The prior receipt suspected installed roster selection. Actual code reads
`ATRIS_RUNNER_PROFILE` directly at `lib/runner-command.js:198`; the roster is not
needed to explain this failure. The current session inherits `codex`.
`test/lesson-gate.test.js:85` intercepts Claude commands only, then falls through
to real execution at line 98. `commands/autopilot.js:3310` builds the proposal
command from the inherited settings. The failing default-format cases at
`test/runner-command.test.js:342` and `:388` bypass `withRunnerEnv`.

Real-surface proof used the actual `buildRunnerCommand` export. No model was
launched. A reviewer can repeat its safe comparison with:

```sh
node - <<'NODE'
const assert = require('node:assert/strict');
const { buildRunnerCommand } = require('./lib/runner-command');
const keys = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE'];
for (const key of keys) delete process.env[key];
process.env.ATRIS_RUNNER_PROFILE = 'codex';
const inherited = buildRunnerCommand({ promptFile: '/tmp/architect-review-prompt.txt' });
console.log(inherited);
assert.match(inherited, /^codex exec /);
process.env.ATRIS_RUNNER_PROFILE = 'claude';
const isolated = buildRunnerCommand({ promptFile: '/tmp/architect-review-prompt.txt' });
console.log(isolated);
assert.match(isolated, /^claude -p /);
NODE
```

Observed output from the comparison, exit 0:

```text
ambient profile: codex
ambient command: codex exec "$(cat /tmp/architect-review-prompt.txt)"
isolated command: claude -p "$(cat '/tmp/architect-review-prompt.txt')" --model claude-opus-5-5
no child engine was launched; both real command builders asserted
```

## Files and administrative limits

Edited this receipt, `atris/team/architect/logs/2026-10-14.md`, `atris/MAP.md`,
and `atris/refs/MAP-NOTES.md`. Task commands generated `atris/TODO.md`; its unrelated queue replacement was
restored to the clean starting copy and excluded from the change.
Created and claimed the local advisory task because the supplied task was absent.
Attaching it to the mission returned exit 3: the outer runner holds the mission
lock. Its process was confirmed alive; no lock or mission setting was changed.
Brain activation and compilation returned exit 2 with `Plan only. Would write:`;
no core policy or member instruction was edited. No implementation was built.

Progress: one advisory verdict, one confirmed cause, two command shapes asserted.
Rollback: revert the documentation change. Implementation remains a later slice.

## Frozen verification and stop reason

Ran once: `npm run test:fast > /tmp/architect-engine-isolation-test-fast.log 2>&1`.
Exit 1. The bare command was not piped or given engine overrides.

```text
ℹ tests 1882
ℹ suites 22
ℹ pass 1877
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 41318.599917
```

Three lesson cases reached real Codex and returned:
`Not inside a trusted directory and --skip-git-repo-check was not specified.`
The command-format cases at lines 342 and 388 received
`codex exec "$(cat /tmp/p.tmp)"` instead of the Claude flags they asserted.
The model-quoting case at line 337 also lacks isolation but passed in this run.

Stop: the frozen check failed. The advisory change is saved and pushed, but
not proof-ready, accepted, or merged. The outer runner holds the mission lock,
so its harness must record the failed check. No mission completion was claimed.
Reviewer rerun: `npm run test:fast`.

next_push: isolate the lesson and default-format tests, rejecting unexpected model launches before execution.

layer: beliefs
