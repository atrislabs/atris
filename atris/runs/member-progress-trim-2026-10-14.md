Member progress logs now trim automatically, verified by the frozen check and the real member board command.

Files edited: lib/member-progress.js, test/member-progress-trim.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/architect/logs/2026-10-14.md, atris/runs/member-progress-trim-2026-10-14.md.

Plan: append -> check size -> recent complete lines plus latest start marker -> board.
Verdict: proceed. The main risk is losing the start marker and process identity; the regression checks both after a trim.

Verify: node --test test/member-progress-trim.test.js
Exit: 0. Exact summary: tests 5, suites 0, pass 5, fail 0, cancelled 0, skipped 0, todo 0.
Related command: node --test test/member-progress-trim.test.js test/member-progress.test.js test/member-board.test.js test/member-progress-codex.test.js
Exit: 0. Summary: tests 36, pass 36, fail 0.
Cleanliness: git diff --check, exit 0, no output.

Real surface: node bin/atris.js member board --all, with ATRIS_PROGRESS_DIR pointing to a generated temporary fixture.
The fixture contained a current start marker and 20,000 old activity lines. The real appendProgress function added the latest step and successful finish before invoking the board.
Exact output excerpt:
bytes before: 1040088, bytes after: 131175
member     state    alive  engine  running for  ago     job                       last step
architect  done ok  no     codex   -            0s ago  keep progress logs small  editing latest activity
board exit: 0

Metric: 87.4% smaller in the real sample. Every append in the 10,000-step regression stayed at or below 262,144 bytes. Oversized logs retain about 131,072 bytes of recent complete lines plus the current start marker.
Cost: old progress lines are discarded; durable mission receipts remain the history source. The existing follower resets on shrink and may replay retained lines. Progress remains best effort, and simultaneous writers to the same member file are not serialized by this slice.

State: the calling runner holds the mission lock, so attach-task returned exit 3 without changing the mission. A local task was created, claimed, and moved to Review with passing proof. The calling runner can record mission completion after this response. No human approval was performed.
Activation and compile commands returned plan-only exit 2; no generated operating instructions were rewritten.

next_push: serialize simultaneous progress writers so trimming cannot replace another writer's new line.
layer: behaviors
