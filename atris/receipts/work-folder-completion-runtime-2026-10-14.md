# Completion check selects an unsupported Node version

Captured the full failing rerun and isolated the difference by changing only the Node binary in the same login shell. No runtime or tool policy changed.

Flow: task ready -> receipt writer -> bash login shell -> Node 20 -> CLI startup refusal.
Control: same bash login shell -> explicit Node 25 -> all 95 checks pass.

## Real surface proof

Actual receipt execution shape, from lib/task-receipt.js: spawnSync('bash', ['-lc', command], { cwd: root, encoding: 'utf8', timeout: 120000 }). Diagnostic capture increased maxBuffer to preserve all output; exit 1 is a completed failing run, with no spawn error.

Completion-shell identity command: bash -lc 'command -v node; node --version'. Exit 0:

```text
/usr/local/bin/node
v20.18.0
```

Direct process identity: /opt/homebrew/Cellar/node/25.6.1/bin/node v25.6.1.

Reproduction command: bash -lc 'node --test test/*worktree*.test.js test/*tidy*.test.js'. Exit 1:

```text
# tests 95
# pass 70
# fail 25
```

Full output: work-folder-completion-rerun-2026-10-14.tap, with trailing spaces removed from blank diagnostic lines. Twenty-four failures explicitly report "atris needs Node 22.13 or newer. this is Node 20.18.0." The remaining failure is "Unexpected end of JSON input" in the outside-Git mission-start test, which parses CLI stdout without checking startup stderr. That attribution is an inference; the supported-runtime control resolves all 25 failures.

Control command: bash -lc '/opt/homebrew/Cellar/node/25.6.1/bin/node --test test/*worktree*.test.js test/*tidy*.test.js'. Exit 0:

```text
ℹ tests 95
ℹ pass 95
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Full output: work-folder-completion-supported-2026-10-14.tap. The absolute binary is this computer's measured path, not a portable fix recommendation. A future fix should use process.execPath and preserve safe command parsing, rather than embed this path.

## Scope and handoff

Edited files: this receipt; both full-output .tap files named above; atris/team/architect/logs/2026-10-14.md. Existing notebook edits were preserved. No production edits, mission changes, dependency changes, acceptance, or folder deletion commands were performed.

Commands run: mission status; git status/diff and remote inspection; Atris boot, task list/show/note; brain activation preview (exit 2, no writes); targeted context and code reads; runtime identity probe; failing and supported login-shell test invocations. Final required proof and landing recorded below.

Metric: all 25 prior failures reproduced, 24 explicit unsupported-runtime refusals, one missing-output parse failure, and all 95 passing with the supported runtime. This removes the unexplained discrepancy; the completion runner still needs a runtime selection fix.

next_push: pin the completion receipt runner to the supported parent Node runtime with a real login-shell regression.

layer: environment

## Required check and delivery

Reviewer command: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`. Actually run by `atris task ready AFW-20 --verify` with that exact command; exit 0, 27 passed, zero failed. Task is in review, with no agent acceptance. Saved task proof: `atris/runs/2026-10-14-task-afw-20-2026-10-14T16-27-07-970Z.json`.

Exact saved output excerpt:

```text
TAP version 13
# Subtest: tidy removes landed clean copies and leaves everything else to git and the rules
ok 1 - tidy removes landed clean copies and leaves everything else to git and the rules
  ---
...
n landing names who removed its scratch folder and why
  ---
  duration_ms: 144.085916
  ...
1..27
# tests 27
# suites 0
# pass 27
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3341.585125
```

Brain activation and compile were previews, exit 2, no files written. Delivery: scoped proof and log commit, pushed to the current remote branch; existing task-view and earlier log changes remain unstaged.
