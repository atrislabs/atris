Short jobs now deliver notes before stopping, verified by the required test and real member commands.

Changed: commands/mission.js, test/member-steer-short-job.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md, this receipt.

Flow: note arrives -> preserve latest notes during session save -> keep job running -> next prompt reads notes -> check -> ready.

Rerun: node --test test/member-steer-short-job.test.js
Exit: 0
Output: tests 2; pass 2; fail 0; cancelled 0; skipped 0.

Real surface command: node test/member-steer-short-job.test.js --proof
This invokes the actual CLI member run command and two actual CLI member steer commands in a temporary workspace with a deterministic local engine executable. No mission runtime functions are mocked.
Exit: 0
Output: member run exited 0; prompts=2; unread=0; check=passed

Progress: two late notes delivered exactly once in the follow-up prompt; a job without notes still runs once. Session promotion preserves notes written while the worker runs. Time limits, aborts, frozen verifier/lane and protected-lane checks remain in force. A note needing another prompt costs another engine turn.

Other commands: atris mission status mission-2026-10-14-a-note-sent-to-a-running-mem-eac3a833 --json; git status --short; atris; atris mission goal --json; atris task list --status open; atris task new; atris task claim; atris task note; atris worktree status; git diff --check (exit 0, no output).

The parent driver owns the mission lock, so mission attach-task returned lock busy. A local task holds the objective and proof instead. Brain activate and compile were invoked; both returned a write plan with exit 2, so no generated policy files were changed.

next_push: keep notes unread when the receiving engine fails before producing a reply.
layer: capabilities
