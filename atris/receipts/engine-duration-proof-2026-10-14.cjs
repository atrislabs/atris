'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { dispatchToEngine } = require('../../lib/fleet');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-duration-proof-'));
const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-duration-work-'));
try {
  execFileSync('git', ['init', '-q', root]);
  const options = { root, worktreePath, engine: 'claude', task: { display_id: 'proof' }, skipBriefCapture: true };
  dispatchToEngine({ ...options, runner: () => ({
    status: 0, stdout: execFileSync(process.execPath, ['-e', 'setTimeout(() => console.log("done"), 50)'], { encoding: 'utf8' }), stderr: '',
  }) });
  let originalError;
  assert.throws(() => dispatchToEngine({ ...options, runner: () => {
    try {
      execFileSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'], { stdio: 'pipe' });
    } catch (error) {
      originalError = error;
      throw error;
    }
  } }), error => error === originalError);
  const lines = fs.readFileSync(path.join(root, '.atris/state/engine-resource.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(line => line.phase), ['start', 'end', 'start', 'end']);
  assert.equal(lines[0].duration_ms, undefined);
  assert.equal(lines[2].duration_ms, undefined);
  assert.ok(lines[1].duration_ms >= 50);
  assert.ok(Number.isInteger(lines[3].duration_ms) && lines[3].duration_ms >= 0);
  assert.equal(lines[3].signal, 'SIGKILL');
  console.log(JSON.stringify({
    phases: lines.map(line => line.phase),
    end_duration_ms: [lines[1].duration_ms, lines[3].duration_ms],
    failure_signal: lines[3].signal,
    original_error_preserved: true,
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(worktreePath, { recursive: true, force: true });
}
