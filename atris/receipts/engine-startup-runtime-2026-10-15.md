# Startup repair commands keep their Node executable

Copied checkout repair commands now use the running Node executable. Verified by 163 passing tests, zero failures, and a clean staged writing check.

Files: lib/engine-resource.js, test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/receipts/engine-startup-runtime-2026-10-15.md. Member log appended at atris/team/executor/logs/2026-10-15.md (ignored by git).

Verify command: `node --test test/engine-resource.test.js test/engine-dispatch.test.js && node bin/atris.js slop --staged`
Exit: 0.
Output excerpt:
```text
✔ copied startup repair commands run without node on PATH
ℹ tests 163
ℹ pass 163
ℹ fail 0
  ✓ clean, no slop tells in 4 files
```

Real command: `node bin/atris.js engine sweep --json`, exit 0. Output excerpt: `"running": 2225, "unread": [], "stopped": [], "failed": []`. This was a read-only scan.
Real shell regression launches copied repair arguments through sh and zsh with PATH empty, exit 0, stdout `["engine","sweep","--fix-startup"]`.
Additional commands: `git diff --cached --check`, exit 0; ancestor check of the requested carry-forward branch, exit 0. Independent review: no findings; targeted real-shell regression exit 0.

Progress: one new regression, 162 to 163 passing tests, no dependencies added. A broad test-text edit initially changed an unrelated injected hint; restored that fixture before the final full run.

Lesson: checkout hints must preserve the running Node executable because service launches can omit it from PATH. The short command for the same checkout still relies on the installed launcher.
next_push: Handle a same-checkout launcher on PATH when its Node executable is absent from PATH.

Brain activation and compile were inspected, both returned plan-only exit 2; unrelated generated adapters were left untouched. Mission task attachment reported its existing lock busy; created a dedicated task instead. Generated task-board changes were restored to avoid unrelated board churn.

Handoff: the installed Atris launcher used unsupported Node 20 and its separate board checks failed. Running `node bin/atris.js task ready` with the supported runtime passed the unchanged frozen command, exit 0, and moved the task to Review. Machine receipt: atris/runs/2026-10-15-task-ecm-4-2026-10-15T07-25-46-837Z.json. Independent code review already found no issues.
layer: behaviors
