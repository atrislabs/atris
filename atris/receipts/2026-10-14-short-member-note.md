Short member jobs now read late notes before the final check. The frozen check passed, and a real command delivered a note inside one work step.

Files changed: commands/mission.js; test/member-steer-short-job.test.js; atris/MAP.md; atris/refs/MAP-NOTES.md; atris/team/architect/logs/2026-10-14.md; this receipt; 2026-10-14-short-member-note-runtime.json.

Plan: worker finishes -> read latest notes -> deliver in same work step -> acknowledge only success -> verify -> finish.

Check: `node --test test/member-steer-short-job.test.js`, exit 0. Output: tests 4, pass 4, fail 0. Cases cover a late note, another note during delivery, failed delivery retaining unread direction, and no extra worker when there is no note.

Additional check: `node --test test/mission-tick-prompt.test.js test/member-progress-codex.test.js test/member-ping-task-dialogue.test.js test/mission-run-reliability.test.js`, exit 0. Output: tests 20, pass 20, fail 0.

Real command: `node /Users/keshavrao/arena/.agent-worktrees/atris-cli/architect-a-note-sent-to-a-running-member-is-a-20261014-115909/bin/atris.js mission run mission-2026-10-14-read-notes-on-a-short-job-1aef0e67 --max-ticks 1 --max-wall 30 --json`, run in the temporary workspace named in the runtime artifact. Exit 0. Output excerpt: `"ran_ticks": 1`, `"operator_notes_read": 1`, `"passed": true`, `"stdout": "late note read before the check\n"`. The worker invoked `member steer architect "read the late note" --json` while the job was running; output mode was `steered_live`.

Metric: one late note read in one allowed work step, with two worker invocations and no second work slice. Failed delivery stays unproven and unread; extra delivery costs another worker call within the original wall budget. The regression uses a local recording worker through the real runner subprocess boundary, not a paid model, and does not exercise the hosted Atris service.

Learning: consuming at the next prompt is insufficient for one-step work. Re-read at the worker return boundary and acknowledge only the delivered batch.

Task proof is in Review. The ready gate reran the frozen command and returned exit 0; its record is atris/runs/2026-10-14-task-aan-1-2026-10-14T12-04-55-495Z.json. The current mission is held by its parent runner, so final mission verification and completion stay with that runner. No mission fields or tool policy changed.

next_push: Show the sender when a member has actually read their note.
layer: capabilities
