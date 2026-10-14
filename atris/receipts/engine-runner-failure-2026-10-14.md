# Final resources survive runner failures

Thrown errors and rejected promises now save final machine resources before passing the original error to the caller. This closes the missing end entry on failed runs without changing dispatch results or failure handling.

Task: EFM-2. Mission: mission-2026-10-14-finish-machine-memory-and-lo-5644339b, increment 9.
Plan: start -> run -> save end on failure -> pass original error.
Changed: lib/fleet.js, test/engine-dispatch.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (rendered by task commands), atris/team/executor/logs/2026-10-14.md, this receipt.
Preserved: the preexisting removal of exported constants in lib/engine-resource.js was not edited or staged.
Local notebook: the member log remains in its existing ignored location. The task command regenerated atris/TODO.md from local task state; that broad rendered change is left unstaged, outside the code delivery.

## Evidence

The first test attempt lacked Git setup and failed before reaching the runner. After correcting the fixture, the failing-first command was:

```sh
node --test --test-name-pattern='thrown and rejected engine runners' test/engine-dispatch.test.js
```

Exit 1. Both real child-process failures showed actual phases `['start']`, expected `['start', 'end']`.

Rerunnable frozen verification:

```sh
node --test test/engine-resource.test.js test/engine-dispatch.test.js
```

Exit 0, exact final output:

```text
ℹ tests 69
ℹ suites 0
ℹ pass 69
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2608.164958
```

The new regression calls the actual dispatch function, kills real Node child processes, and checks both thrown and rejected errors by identity. It checks exactly one start and one end, engine/task matching, load, signal, and cause. A separate live invocation on this computer also passed:

```sh
node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { dispatchToEngine } = require('./lib/fleet');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-proof-'));
const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-resource-work-'));
try {
  execFileSync('git', ['init', '-q', root]);
  let childError;
  try {
    dispatchToEngine({ root, worktreePath: worktree, engine: 'claude', task: { display_id: 'proof' }, skipBriefCapture: true,
      runner: () => {
        try { execFileSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], { stdio: 'pipe' }); }
        catch (error) { childError = error; throw error; }
      }
    });
    throw new Error('expected the runner to throw');
  } catch (error) {
    if (error !== childError) throw error;
  }
  const entries = fs.readFileSync(path.join(root, '.atris/state/engine-resource.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  require('node:assert/strict').deepEqual(entries.map(entry => entry.phase), ['start', 'end']);
  console.log(JSON.stringify({ phases: entries.map(entry => entry.phase), signal: entries[1].signal, cause: entries[1].cause, end_load: entries[1].load, original_error_preserved: true }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(worktree, { recursive: true, force: true });
}
NODE
```

Exit 0, exact output:

```json
{"phases":["start","end"],"signal":"SIGKILL","cause":"killed (cause unknown)","end_load":[8.74,30.64,39.65],"original_error_preserved":true}
```

`git diff --check`: exit 0, no output. Second-model read-only review approved with no defects. No dependencies added.
Task proof is in Review. The ready command reran the frozen check successfully; its first attempt rejected jargon in the landing sentence, then the plain sentence passed. Final proof artifact: atris/runs/2026-10-14-task-efm-2-2026-10-14T12-42-05-129Z.json.
`atris brain activate --root . --verify`: exit 2, plan-only output. `atris brain compile --root .`: exit 0, plan-only output; generated policy adapters were kept outside this slice.

Metric: both failure paths now record one end event, versus zero before; 69 checks passed, zero failed.
next_push: add a shared run identifier to start and end resource lines so overlapping runs of the same engine and task can be paired.
layer: capabilities
