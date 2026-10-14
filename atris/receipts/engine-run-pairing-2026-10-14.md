# Resource records stay paired across overlapping runs

Each dispatch now gives its start and end resource records the same unique run identifier. Repeated attempts and overlapping runs of the same task can be matched even when they finish in reverse order.

Task: EFM-3. Mission increment: 10.
Plan: start -> shared run identifier -> end, including runner failures.
Edited: lib/engine-resource.js, lib/fleet.js, test/engine-resource.test.js, test/engine-dispatch.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, this receipt.
The member log stays in its existing ignored location. The task commands regenerated atris/TODO.md; the rendered changes remain unstaged. The preexisting removal of exported constants in lib/engine-resource.js is excluded from delivery.

## Proof

Failing-first command:
```sh
node --test --test-name-pattern='start and end lines|every engine run|thrown and rejected engine runners' test/engine-resource.test.js test/engine-dispatch.test.js
```
Exit 1. All five checks failed because run_id was undefined, including the real child-process failure cases.

Rerunnable frozen verification:
```sh
node --test test/engine-resource.test.js test/engine-dispatch.test.js
```
Exit 0. Exact final output:
```text
ℹ tests 70
ℹ suites 0
ℹ pass 70
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2800.453666
```

Live invocation of the changed dispatch function:
```sh
node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { dispatchToEngine } = require('./lib/fleet');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pair-proof-'));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pair-work-'));
  let child;
  let pending;
  try {
    execFileSync('git', ['init', '-q', root]);
    const options = { root, worktreePath: worktree, engine: 'claude', task: { display_id: 'proof' }, skipBriefCapture: true };
    pending = dispatchToEngine({ ...options, runner: () => new Promise((resolve, reject) => {
      child = execFile(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ status: 0, stdout, stderr });
      });
    }) });
    dispatchToEngine({ ...options, runner: () => ({ status: 0, stdout: execFileSync(process.execPath, ['-e', 'console.log("done")'], { encoding: 'utf8' }), stderr: '' }) });
    child.stdin.end();
    await pending;
    const lines = fs.readFileSync(path.join(root, '.atris/state/engine-resource.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(line => line.phase), ['start', 'start', 'end', 'end']);
    assert.notEqual(lines[0].run_id, lines[1].run_id);
    assert.equal(lines[0].run_id, lines[3].run_id);
    assert.equal(lines[1].run_id, lines[2].run_id);
    console.log(JSON.stringify({ phases: lines.map(line => line.phase), distinct_runs: new Set(lines.map(line => line.run_id)).size, matched_pairs: 2, load_readings: lines.map(line => line.load) }));
  } finally {
    if (child) child.stdin.end();
    if (pending) await pending;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
```
Exit 0. Exact output:
```json
{"phases":["start","start","end","end"],"distinct_runs":2,"matched_pairs":2,"load_readings":[[5.35,15.38,29.62],[5.35,15.38,29.62],[5.35,15.38,29.62],[5.35,15.38,29.62]]}
```

The first live attempt used the primary temporary repository as the dispatch folder and was correctly refused before launch, exit 1. Giving the dispatch a separate temporary folder fixed the proof setup.

git diff --check: exit 0, no output.
Independent read-only review approved with no defects; the reviewer did not rerun tests.
Task proof is in Review. The ready command reran the frozen check successfully, exit 0; proof artifact: atris/runs/2026-10-14-task-efm-3-2026-10-14T12-47-12-996Z.json. Its first attempt rejected the result sentence for omitting an explicit benefit; the corrected sentence names the time saved investigating overlapping jobs.
Brain activation and compile reported plan-only output, exit 2; generated policy adapters stay outside this slice.
No dependencies added. Older resource lines remain readable and are not rewritten.

Metric: two overlapping runs produced four records and two correctly matched pairs; 70 checks passed, zero failed.
next_push: record elapsed duration on each end resource line so failed and successful runs can be compared.
layer: capabilities
