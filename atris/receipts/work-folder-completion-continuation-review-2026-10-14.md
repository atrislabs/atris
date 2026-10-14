# Continued shell function review

Verdict: proceed-with-changes. Classify backslash-newline continuations before
excluding a leading shell function from the proposed runtime rewrite. Keep
the original command byte for byte when it defines a function; use normalized
text only for classification, never as the executed or recorded command.

The single failure mode remains a false passing receipt. A definition written
as `node` followed by whitespace, a backslash-newline, and `()` bypasses the
prior function exclusion. The real receipt writer loses the intended output
while returning exit 0. Removing backslash-newline pairs for classification
recognizes this definition and preserves its output in the diagnostic control.
This is pre-build evidence, not a production repair or a general shell parser.

Flow: continued definition -> diagnostic exclusion -> actual receipt writer
-> login shell -> saved output and exit.

## Real proof

Command: `node atris/receipts/work-folder-completion-function-probe.js`
Exit: 0. Seven actual receipt executions passed their assertions, including
these three new controls:

```text
original continued function: continued function retained, exit 0, receipt retained
prior exclusion misses continuation: invalid function name, intended output lost, exit 0, receipt retained
continued function exclusion control: continued function retained, exit 0, receipt retained
```

Artifacts: seven JSON receipts in atris/runs with timestamp prefix
2026-10-14T16-44-38 and task slug completion-function. No folders removed.
Edited: function probe, this review, atris/MAP.md, atris/refs/MAP-NOTES.md,
and atris/team/architect/logs/2026-10-14.md. Prior log changes and the generated
task view remain outside the scoped commit.
Commands: mission status/goal, activation preview, task list/new/claim/note,
targeted reads, git status/diff/remotes, real probe, task ready with required
tests, compile preview, scoped commit and push.

Rerun: `node --test test/worktree-removal-guard.test.js test/member-tidy.test.js`
Metric: three additional real controls, seven total; one exclusion gap proven
and one narrow classification safeguard reviewed.
next_push: build the leading-node runtime repair with continued function preservation and a real competing-runtime regression.
layer: capabilities

## Required check and delivery

Required command ran through the actual readiness receipt writer, exit 0.
Saved output excerpt: `# tests 27`, `# pass 27`, `# fail 0`, `# skipped 0`.
Receipt: atris/runs/2026-10-14-task-afw-24-2026-10-14T16-45-37-623Z.json.
The first readiness invocation passed the tests but rejected the landing
sentence; the proof-only retry required execution in its own process.
The final corrected readiness invocation passed and placed proof in review.
Activation and compile were previews, exit 2, and wrote nothing.
Delivery: scoped commit and push. No second slice or production change.
