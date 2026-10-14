# Completion shell compatibility review

Verdict: proceed-with-changes. The saved leading-node repair plan is compatible
with the actual receipt writer when the parent executable is correctly quoted.
One risk remains: a rewrite that parses or reconstructs the shell suffix can
change arguments. Replace only the leading standalone node word, retain the
suffix byte for byte, and keep the original command in production receipts.

Flow: quoted parent binary -> existing login shell -> real receipt writer.

This is pre-build evidence, not a production repair. The controls explicitly
name the parent binary. They do not test a rewrite implementation or a competing
runtime in a controlled login shell. Those remain the builder's regression work.
No policy changes, new dependencies, production edits, or folder removals.

## Real surface proof

Command: node atris/receipts/work-folder-completion-shell-probe.js
Exit: 0. Actual output:

```text
unusual executable path: v25.6.1, exit 0, receipt retained
quoted arguments: ["two words","apostrophe's value","$HOME; `literal`"], exit 0, receipt retained
glob expansion: alpha.js,beta.js, exit 0, receipt retained
shell suffix: shell suffix retained, exit 0, receipt retained
non-node command: ordinary shell retained, exit 0, receipt retained
child failure: child failure retained, exit 7, receipt retained
control only: production node selection remains unchanged
```

Artifacts: six JSON receipts and a uniquely named local fixture under atris/runs.
The fixture contains a parent-binary symlink and two empty glob inputs; all are
retained locally, outside version control. Saved receipt command, exit, pass
status, and output were asserted for each case, including the failing child.

Edited: this review, work-folder-completion-shell-probe.js, atris/MAP.md,
atris/refs/MAP-NOTES.md, and atris/team/architect/logs/2026-10-14.md.
Commands: git status/log/remotes; mission status/goal; task list/new/claim/note;
activation and boot; targeted file reads; real probe; task ready with required
check; compile preview; scoped git diff/check/add/commit/push.

Metric: six real shell controls passed, including retained failure evidence.
Rerun: node atris/receipts/work-folder-completion-shell-probe.js
Required check: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js

next_push: build the leading-node runtime repair with a real competing-login-runtime regression and original command retention.
layer: capabilities

## Required check and delivery

Required command ran through the actual readiness receipt writer, exit 0:

```text
1..27
# tests 27
# suites 0
# pass 27
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Receipt: atris/runs/2026-10-14-task-afw-22-2026-10-14T16-37-14-265Z.json.
Task moved to review. The first readiness attempt passed the check but rejected
its landing sentence; the corrected sentence passed readiness with the same
required command. No second work slice was started. Brain activation and compile
were previews and wrote nothing. Scoped commit and push preserve unrelated edits.
