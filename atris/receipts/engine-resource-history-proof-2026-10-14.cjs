'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recordEngineResource, readResourceHistory, RESOURCE_LOG } = require('../../lib/engine-resource');
const cli = path.resolve(__dirname, '../../bin/atris.js');
const room = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-history-proof-'));
const root = path.join(room, 'main');
const linked = path.join(room, 'linked');
fs.mkdirSync(root);
function git(args) {
  const result = spawnSync('git', ['-c', 'user.name=resource proof', '-c', 'user.email=resource@example.com', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
try {
  git(['init', '-q']);
  git(['commit', '-q', '--allow-empty', '-m', 'init']);
  git(['worktree', 'add', '-q', '--detach', linked]);
  recordEngineResource(linked, { phase: 'start', engine: 'node', run_id: 'history-proof' });
  const child = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']);
  assert.equal(child.signal, 'SIGKILL');
  recordEngineResource(linked, { phase: 'end', engine: 'node', run_id: 'history-proof', signal: child.signal });
  const sweep = spawnSync(process.execPath, [cli, 'engine', 'sweep'], { cwd: linked, encoding: 'utf8' });
  process.stdout.write(sweep.stdout);
  assert.equal(sweep.status, 0, sweep.stderr);
  assert.match(sweep.stdout, /last SIGKILL: node/);
  assert.equal(fs.existsSync(path.join(linked, RESOURCE_LOG)), false);
  git(['worktree', 'remove', linked]);
  const history = readResourceHistory(root);
  assert.equal(history.kills, 1);
  assert.equal(history.last_kill.run_id, 'history-proof');
  console.log('resource records retained after build folder removal: 2');
  console.log('recorded kills retained: 1');
} finally {
  fs.rmSync(room, { recursive: true, force: true });
}
