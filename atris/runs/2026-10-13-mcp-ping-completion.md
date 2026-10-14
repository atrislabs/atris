# MCP ping completion

The pending-call ping test releases its HTTP response on the real child's ping reply instead of sleeping for a second. Three baseline runs and three changed runs passed all 16 tests with exit 0.

## Scope and proof

Only one test file changed: `test/mcp.test.js`. Original response order `[1, 4, 3]` and `Delayed` payload assertions remain. The child still runs the real CLI from a disposable home and uses a local HTTP server. Incremental stdout parsing invokes a response callback once per complete line; final parsing still rejects non-JSON stdout. The response is released during cleanup if the child times out. No product code or dependencies changed.

Plan: fixed sleep -> real ping reply -> release HTTP response -> original assertions.

Rerun: `node --test test/mcp.test.js`.

| Run | Pending ping ms | Whole file ms | Result |
| --- | ---: | ---: | --- |
| Before 1 | 1125.680042 | 15096.388375 | 16 pass, 0 fail, exit 0 |
| Before 2 | 1087.140917 | 14704.939625 | 16 pass, 0 fail, exit 0 |
| Before 3 | 1092.432750 | 14725.197917 | 16 pass, 0 fail, exit 0 |
| After 1 | 81.721667 | 13626.417708 | 16 pass, 0 fail, exit 0 |
| After 2 | 81.687292 | 13650.144000 | 16 pass, 0 fail, exit 0 |
| After 3 | 81.446417 | 13669.554250 | 16 pass, 0 fail, exit 0 |

Invocations overlapped within the before and after groups. Median ping duration fell 92.5%; median whole-file duration fell 7.3%. These runs show no observed flakiness, not a guarantee against all flakiness. The unchanged poll retry checks account for most of the remaining duration.

Actual output excerpt, after run 2:

```text
✔ atris mcp answers ping while a design call is pending (81.687292ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13650.144
```

Frozen check: `git diff --check`, exit 0, no output.

Other edited files: `atris/MAP.md`, `atris/refs/MAP-NOTES.md`, `atris/team/auto-improver/logs/2026-10-13.md`, with no product changes. The task commands regenerated `atris/TODO.md` from local task state; that unrelated bulk replacement was excluded and the tracked view restored. This receipt is the new proof artifact. Task creation, claim, note, and ready commands updated durable local task state. The successful ready command reran `node --test test/mcp.test.js` with exit 0 and saved `atris/runs/2026-10-14-task-ait-2-2026-10-14T05-58-24-999Z.json`; the task remains in review and was not self-accepted. Brain activate and compile were invoked as required but returned plan-only status 2; no brain or adapter files were generated to expand this slice.

next_push: measure the design polling tests and find a way to preserve real retry coverage without paying the full production poll interval.

layer: capabilities
