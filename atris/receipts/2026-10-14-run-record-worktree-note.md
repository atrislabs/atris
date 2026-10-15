## Run-record fake worktree writes its note, 2026-10-14

The run-record test's fake worktree setup now writes the small note file the real setup writes (owner, task, and base). The dispatch brief reads those from the file instead of falling back to several git calls per dispatch.

Behavior: real worktree setup always writes this note, so the tests now follow the real path more closely. Briefs written during these tests now name the engine as author and HEAD as base, where before they fell back to a default author and an empty base. No run record assertion changed.

Proof: `node --test test/roster-run-record.test.js` exited 0 twice: `tests 12`, `pass 12`, `fail 0`, at 17288ms and 17754ms. The committed version ran at 21375ms and 21419ms under the same load.

Metric: about 3.9 seconds off a 21.4 second file, roughly 18 percent. Across today's two changes the file went from about 23.5 seconds to about 17.5.

Files: test/roster-run-record.test.js, atris/refs/MAP-NOTES.md, atris/receipts/2026-10-14-run-record-worktree-note.md, atris/team/auto-improver/logs/2026-10-14.md.

Lesson: a fake that skips a file the real step writes pushes the code under test onto its slow fallback path. Matching the real step's output is both faster and more faithful.

next_push: give the one-lap review case's fake worktree the same note, or move to the next slowest test file, profiled first.
layer: capabilities
