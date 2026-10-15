# Completion runtime repair review

Verdict: proceed-with-changes.

The actual receipt writer selects Node 20.18.0 through its login shell while
its parent runs Node 25.6.1. An explicitly quoted parent binary, executed
through that same receipt writer, selects Node 25.6.1. The prior broader
suite receipt records 25 failures disappearing with that one change.

The single risk is breaking existing shell commands while trying to pin
Node. The receipt writer accepts shell commands, including globs; the
strict recheck runner intentionally accepts a smaller command language.
Replacing the receipt writer with that runner would change this boundary.

Build the narrow repair in lib/task-receipt.js: for a command beginning
with the literal standalone word node, use a shell-quoted process.execPath
as that first word and preserve the remaining shell text. Preserve the
original command in the receipt. Leave other commands on their existing
path. Do not embed this computer's binary path, change tool policy, or
rewrite arbitrary occurrences of node. Prefix assignments and cd commands
remain outside this first repair and must be reported as a limitation.

Before building, require a real receipt-writer regression with a login
shell selecting a competing Node executable. Check direct node tests,
glob expansion, an executable path containing spaces or an apostrophe,
non-node commands, and a failed child retaining its exit code and receipt.
Existing strict-parser rejection tests must stay unchanged.

## Proof

Flow: parent -> actual receipt writer -> login shell -> selected runtime.
Control: parent -> actual receipt writer -> quoted parent binary.

Command: node atris/receipts/work-folder-completion-runtime-probe.js
Exit: 0. Actual output:

```text
parent runtime: /opt/homebrew/Cellar/node/25.6.1/bin/node v25.6.1
login selection: v20.18.0, exit 0
command: node --version
receipt: atris/runs/2026-10-14-task-completion-runtime-probe-2026-10-14T16-32-26-999Z.json
parent runtime control: v25.6.1, exit 0
command: '/opt/homebrew/Cellar/node/25.6.1/bin/node' --version
receipt: atris/runs/2026-10-14-task-completion-runtime-probe-2026-10-14T16-32-27-029Z.json
```

The probe observes selection; it does not claim production behavior is repaired.
It creates two evidence files under atris/runs and removes nothing.

Edited: this review, the adjacent runtime probe, both map files, and the
architect member log. Existing task-view and member-log changes are preserved.
Inspected: lib/task-receipt.js, lib/auto-accept-certified.js,
test/task-receipt.test.js, mission status, task state, and prior runtime proof.
Commands: activation preview, Atris boot, mission status and goal, task
list/new/claim/note, git status/diff/remotes, targeted reads, the probe,
required tests, task ready, compile preview, scoped commit and push.

Metric: two real receipt executions isolate runtime selection; one bounded
repair plan names shell compatibility as the required safeguard.

next_push: pin only a leading node command in the completion receipt writer to the parent runtime, retaining shell arguments and original receipt text.

layer: capabilities

## Required check and delivery

Command: node --test test/worktree-removal-guard.test.js test/member-tidy.test.js
Exit: 0. Full output: work-folder-completion-plan-tests-2026-10-14.tap.

```text
ℹ tests 27
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Activation and compile previews exited 2 and wrote nothing. The task is in
review. Delivery is a scoped commit and push of this proof and review.

Readiness reran the exact required command through the completion runner,
exit 0. Receipt: atris/runs/2026-10-14-task-afw-21-2026-10-14T16-33-43-304Z.json.
Initial proof-only attempts were rejected because readiness requires its own
execution; the final execution passed and moved the task into review.

## Shared proof runner follow-up, October 14

Verdict: proceed-with-changes. The receipt writer now restores the caller's
Node directory after login startup in lib/task-receipt.js:59. Its earlier
leading-word proposal above is historical, not the current implementation.
The shared proof runner at lib/task-proof.js:157 still runs the command
without that restoration.

The single risk remains changing shell command meaning. Use the receipt
writer's existing post-login PATH prefix rather than replacing the shell or
rewriting the caller's command. Keep the original command in proof text.
Do not change the strict certification parser or its allowlist.

Flow: login profile -> caller Node directory first -> unchanged shell command.

The real shared-runner probe compares baseline selection with that prefix:
Node 20.18.0 becomes caller Node 25.6.1, a quoted variable stays one argument,
a filename glob expands, and a child exit of 7 remains a failed proof.
Command: node atris/receipts/work-folder-proof-runtime-probe.js, exit 0.
This is advisory evidence, not an implementation or a portable regression.

Before building, require a real-runner regression with a controlled competing
Node on the login path, caller paths containing spaces and an apostrophe,
non-Node commands, and the original command preserved in returned proof.
Caller runtime wins by default; an explicit command PATH override remains
possible. Login functions or aliases and commands that reset PATH need
separate evidence before claiming universal retention.

next_push: align the shared proof runner with the receipt writer's post-login Node directory restoration and add a controlled real-shell regression.

## Controlled runtime evidence, October 14

Verdict: proceed-with-changes. Six actual login-shell children in
work-folder-proof-runtime-controlled.js prove competing executable selection,
caller restoration from a copied Node in a path with spaces and an apostrophe,
quoted variables and globs, ordinary shell commands, child exit 7, and an
explicit PATH override. Returned commands and proof retain the original text.

Flow: real login shell -> controlled competing PATH -> candidate prefix -> command.

The injected runner changes startup text and invokes actual bash. It does not
fabricate process results or change production. This proves the candidate
under a controlled post-login PATH, not every login profile. The first probe
failed before running any candidate because copied Homebrew Node needs its
shared libraries. A temporary link supplies them. Only generated fixtures
are removed.

The single risk remains shell compatibility. Before delivery, implementation
must retain this coverage as an automated regression against the production
runner without an injected candidate prefix. Preserve explicit PATH overrides.

next_push: implement the reviewed caller-directory restoration in the shared proof runner with this controlled regression covering the production path.
