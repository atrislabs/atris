# Thrown runner timeout proof

Added regression proof that a real timed-out child saves exactly one paired end with its known cause before rethrowing the original error. No runtime change was needed.

Files edited: test/engine-dispatch.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, this receipt.

Verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js` with `/opt/homebrew/bin` first in PATH, Node 25.6.1. Exit 0.
Output: 93 tests, 93 pass, 0 fail, 0 skipped.
`git diff --check`: exit 0, no output.
Focused command: `node --test --test-name-pattern='a thrown child timeout' test/engine-dispatch.test.js`: exit 0, one pass. It passed before implementation edits; this is new coverage, not a failing-first repair.

Real surface excerpt:
```text
real child timeout: {"at":"2026-10-14T15:07:07.157Z","phase":"end","engine":"claude","task":"CLI-900","free_pct":79,"swap_used_mb":1172.75,"swap_total_mb":2048,"load":[4.89,4.8,5.12],"run_id":"ad162cc1-f20a-4857-83e4-051a17bc75d0","duration_ms":103,"signal":"SIGKILL","timed_out":true,"cause":"killed (time limit reached)"}
```

The first full invocation selected unsupported Node 20.18.0 and exited 1: 89 pass, four existing CLI checks rejected that runtime. Repeated the exact frozen command with the supported installed Node and passed.

Independent review: approved; real child, original error identity, pairing, timeout cause, load, elapsed time and cleanup checked.
Inspection: atris mission status, mission goal, task list, git status, mapped source and tests. Task claimed and objective recorded. Mission attach-task refused a busy lock; no mission or lock was changed. Brain activate and compile returned plan-only output; generated policy files were preserved.

Metric: one new real-runtime regression, total passing checks increased from 92 to 93.
next_push: prove mission startup errors retain exactly one paired final resource reading.
layer: capabilities
