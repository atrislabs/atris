'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
const { acceptCommandArgs } = require('../commands/autoland');
const autoland = require('../lib/autoland');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'check.test.js'), "require('node:test')('check', () => {});\n");
  return root;
}
function task(root, tag, verify = 'node --test check.test.js') {
  return { id: 'test', status: 'review', tag, workspace_root: root,
    metadata: { approval_status: 'pending', agent_certified: true, agent_review_pass_count: 2, verify, latest_agent_proof: 'node --test check.test.js passed' },
    review: { approval_status: 'pending', agent_certified: true, agent_review_pass_count: 2, proof: 'node --test check.test.js passed' },
    events: [{ event_type: 'proof_ready', actor: 'builder' }, { event_type: 'reviewed', actor: 'reviewer' }] };
}
test('protected tasks require the option and a passing check', (t) => {
  const root = fixture(t);
  for (const tag of ['money', 'customer']) {
    const row = task(root, tag);
    assert.equal(evaluateAutoAccept(row, { acceptAll: true }).reason, `denied_tag_${tag}`);
    assert.equal(evaluateAutoAccept(row, { acceptAll: true, includeProtected: true }).eligible, true);
    row.metadata.verify = 'git diff --check';
    assert.equal(evaluateAutoAccept(row, { acceptAll: true, includeProtected: true }).reason, 'non_falsifying_verify');
    row.metadata.verify = 'node --test check.test.js';
    fs.writeFileSync(path.join(root, 'check.test.js'), "require('node:test')('check', () => { throw Error('failed'); });\n");
    assert.equal(evaluateAutoAccept(row, { acceptAll: true, includeProtected: true }).reason, 'verify_failed');
    fs.writeFileSync(path.join(root, 'check.test.js'), "require('node:test')('check', () => {});\n");
  }
});
test('owner policy persists the option and resets it on the next ordinary activation', (t) => {
  const root = fixture(t);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'crontab'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'autoland', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  let result = run('on', '--all', '--include-protected');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(autoland.readPolicy(root).accept_protected, true);
  assert.match(result.stdout, /protected work .* also lands itself; sends and payments still need you\./);
  result = run(); assert.match(result.stdout, /bar: protected work/);
  result = run('off'); assert.equal(result.status, 0, result.stderr);
  assert.equal(autoland.readPolicy(root).enabled, false);
  result = run('on'); assert.equal(result.status, 0, result.stderr);
  assert.equal(autoland.readPolicy(root).accept_protected, false);
});
test('heartbeat passes the option only when the policy includes it', () => {
  assert.ok(acceptCommandArgs({ accept_protected: true }).includes('--include-protected'));
  assert.ok(!acceptCommandArgs({ accept_protected: false }).includes('--include-protected'));
  assert.ok(!acceptCommandArgs({}).includes('--include-protected'));
});
test('sweep records the owner policy in the accepted proof and still blocks agents', (t) => {
  const root = fixture(t);
  const cli = path.resolve(__dirname, '../bin/atris.js');
  const env = { ...process.env, ATRIS_TASKS_DB: path.join(root, 'tasks.db'), ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1', ATRIS_AGENT_PROOF_ONLY: '0' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  const created = run(['task', 'new', 'check customer records', '--tag', 'customer', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const row = JSON.parse(created.stdout).task;
  const claim = run(['task', 'claim', row.display_id, '--as', 'builder']);
  assert.equal(claim.status, 0, claim.stderr);
  const db = require('../lib/task-db');
  const ready = db.readyTask(db.open(env.ATRIS_TASKS_DB), { id: row.id, actor: 'builder', proof: 'node --test check.test.js passed with a real check for customer records.' });
  assert.equal(ready.ready, true, ready.reason);
  let result = run(['task', 'sweep', '--auto-accept', '--include-protected', '--json'], { ATRIS_AGENT_PROOF_ONLY: '1' });
  assert.notEqual(result.status, 0);
  result = run(['task', 'sweep', '--auto-accept', '--json']);
  assert.equal(JSON.parse(result.stdout).summary.accepted, 0);
  result = run(['task', 'sweep', '--auto-accept', '--include-protected', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.accepted, 1, result.stdout);
  result = run(['task', 'events', row.display_id, '--json']);
  assert.match(result.stdout, /protected lane accepted by owner policy \(customer\)/);
});
