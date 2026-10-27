# Member job-first proof

The shared work prompt now directs every engine to begin on the job while retaining the member context, lane, verifier, and stop rules.

A real scratch repository contained `greeting.txt` with `old greeting`, a builder identity, and workspace instructions to run Atris and read the map first. Both runs used `node bin/atris.js member run builder 'Change greeting.txt from old greeting to hello world. Only edit greeting.txt; do not commit or push.' --engine codex --ignite --no-referee --shared-checkout --max-ticks 1 --minutes 3 --verify 'grep -qx "hello world" greeting.txt' --json` (with the absolute CLI path). Both exited 0 and their checks passed.

Before the change, the worker reported running `atris`, `atris task list`, mission status and `git status`; its engine time was 14.735 seconds. After the change, a separately traced real run started with `cat greeting.txt`, returned `old greeting` with exit 0, then wrote the requested greeting and checked it with exit 0. Its engine time was 20.935 seconds. The trace was captured by a pass-through wrapper around the real Codex executable. These single-run times do not establish a speedup.

The scratch run result and trace are at `/tmp/atris-first-job-trace-result.json` and `/tmp/atris-first-job-trace-ywaatO/trace.jsonl`; the baseline is at `/tmp/atris-first-job-before.json`. The shared prompt test covers identity, lane, stop condition, and the job-first instruction.
