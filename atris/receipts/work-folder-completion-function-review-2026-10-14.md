# Completion shell function boundary review

Verdict: proceed-with-changes. Exclude a leading shell function definition
before replacing the standalone node word. The saved runtime repair plan
requires this additional safeguard before implementation.

The single risk is a false passing receipt. `node () { ...; }; node` defines
and invokes a shell function. Replacing its leading name with the quoted
parent binary produces an invalid function identifier. The trailing node
still exits 0 on this computer, so the receipt passes although the intended
function output disappeared. The original command and the function-exclusion
control both preserve that output. An ordinary node command still selects
the parent runtime in the candidate control.

Flow: original or diagnostic candidate -> actual receipt writer -> login shell.

This probe reviews a proposed rewrite, not production behavior. Require the
builder's regression to leave shell function definitions byte for byte intact,
then retain all safeguards in the prior runtime and shell compatibility plans.
Do not infer command success solely from a zero exit when testing rewrites.

## Real surface proof

Command: node atris/receipts/work-folder-completion-function-probe.js
Exit: 0. Actual output excerpt:

```text
original function: function retained, exit 0, receipt retained
naive leading-word candidate: invalid function name, intended output lost, exit 0, receipt retained
function exclusion control: function retained, exit 0, receipt retained
ordinary node candidate: v25.6.1, exit 0, receipt retained
diagnostic only: exclude shell function definitions before replacing the leading node word
```

Four JSON evidence files are retained under atris/runs, with timestamp
2026-10-14T16-40-27 and task slug completion-function. The first probe run
exited 1 because it expected the invalid definition to exit 2. Actual bash
behavior returned 0 after the trailing command. The corrected probe asserts
both that misleading success status and the missing intended output.

Edited: this review, work-folder-completion-function-probe.js, atris/MAP.md,
atris/refs/MAP-NOTES.md, and atris/team/architect/logs/2026-10-14.md.
Read only: lib/task-receipt.js, test/task-receipt.test.js, earlier runtime
review and shell controls, member identity, mission and task state.
Commands: mission status/goal, git status/log/remotes/diff, task list/new/claim/note,
activation preview and boot, targeted reads, real probe, task ready with the
required check, compile preview, scoped commit and push.

Metric: four real executions isolate one false-success risk and one safeguard.
Rerun: node atris/receipts/work-folder-completion-function-probe.js
Required check: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js

next_push: build the leading-node runtime repair while preserving leading shell function definitions, with a real competing-runtime regression.
layer: capabilities

## Required check and delivery

The required command ran through the actual readiness receipt writer, exit 0.

```text
1..27
# tests 27
# pass 27
# fail 0
# cancelled 0
# skipped 0
```

Receipt: atris/runs/2026-10-14-task-afw-23-2026-10-14T16-41-14-310Z.json.
Proof is in review. Activation and compile were previews and wrote nothing.
Delivery is a scoped commit and push; earlier log and task-view changes stay
outside this commit. No second work slice was started.
