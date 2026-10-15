Engine starts now record how many SSH helpers look leaked, verified with failing-first tests, the required checks, and a live machine read.

Files: lib/engine-resource.js, test/engine-resource.test.js, test/engine-dispatch.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt.

Plan: start -> read helpers -> apply existing sweep filter -> append count with resources.

Failing-first: node --test test/engine-resource.test.js exited 1, with 17 passes and 2 failures because leaked_ssh_agents was absent.
Verify: node --test test/engine-resource.test.js test/engine-dispatch.test.js exited 0.
Exact summary: tests 66; suites 0; pass 66; fail 0; cancelled 0; skipped 0; todo 0.

Real surface command, exit 0:
```sh
node - <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordEngineResource, RESOURCE_LOG } = require('./lib/engine-resource');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-live-'));
try {
  recordEngineResource(root, { phase: 'start', engine: 'resource-proof', task: 'live-read' });
  console.log(fs.readFileSync(path.join(root, RESOURCE_LOG), 'utf8').trim());
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
NODE
```
Exact output:
```json
{"at":"2026-10-14T12:31:31.070Z","phase":"start","engine":"resource-proof","task":"live-read","free_pct":76,"swap_used_mb":1196.75,"swap_total_mb":2048,"load":[81.71,69.2,48.26],"leaked_ssh_agents":63}
```

Progress: one start-only count field, one new regression case, one real dispatch assertion, 66 passing checks. End lines avoid another process scan. The count is the number proven leaked by the existing conservative filter, not every possibly leaked helper. No process was stopped.

Review: a second model approved this slice without findings. The pre-existing export removals were excluded.
State: mission attachment could not write because its lock was held by another process; a dedicated task carries this slice's objective and proof. The mission remains running.
next_push: preserve an end resource record when the engine runner throws or rejects before returning its result.
layer: capabilities
