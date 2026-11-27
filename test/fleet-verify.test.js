'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');

const cli = path.resolve(__dirname, '../bin/atris.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-verify-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coordinator = path.join(root, 'coordinator');
  fs.mkdirSync(coordinator);
  const witness = path.join(root, 'ran.log');
  const manifest = path.join(root, 'manifest.json');
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    ATRIS_SKIP_UPDATE_CHECK: '1',
  };
  const record = name => `require('node:fs').appendFileSync(${JSON.stringify(witness)}, ${JSON.stringify(name + '\n')});`;
  const repo = (name, files) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const git = (...args) => execFileSync('git', args, { env, cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
    git('add', '.');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture');
    return { name, repo: './' + name, revision: git('rev-parse', 'HEAD'), verify: ['node', 'check.js'] };
  };
  function invokeWith(overrides, ...flags) {
    const child = spawn(process.execPath, [cli, 'fleet', 'verify', manifest, '--json', ...flags], {
      cwd: coordinator, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (signal) return resolve({ signal });
        try { resolve({ code, data: JSON.parse(stdout) }); }
        catch (error) { reject(new Error(`expected JSON, got ${stdout} ${stderr}`)); }
      });
    });
    return { child, result };
  }
  const save = doc => fs.writeFileSync(manifest, JSON.stringify(doc));
  const rows = () => fs.existsSync(witness) ? fs.readFileSync(witness, 'utf8').trim().split('\n') : [];
  return { root, coordinator, repo, record, invoke: (...flags) => invokeWith({}, ...flags), invokeWith, save, rows };
}

test('resumes a missing target and verifies the committed pair in fresh snapshots', async t => {
  const f = fixture(t);
  const cliTarget = f.repo('client', {
    'contract': 'old',
    'check.js': f.record('client') + "require('node:fs').writeFileSync('contract','modified by target check');",
    'join.js': f.record('joint') + "const fs=require('node:fs'); const path=require('node:path'); " +
      "process.exit(fs.readFileSync('contract','utf8') === fs.readFileSync(path.join(process.argv[2], 'contract'),'utf8') ? 0 : 23);",
  });
  const server = f.repo('server', { 'contract': 'old', 'check.js': f.record('server') });
  const doc = { version: 1, targets: [cliTarget, server], joint: { cwd: 'client', verify: ['node', 'join.js', '{repo:server}'] } };
  f.save(doc);
  fs.writeFileSync(path.join(f.root, 'client/contract'), 'user local edit');
  fs.renameSync(path.join(f.root, 'server'), path.join(f.root, 'away'));
  const partial = await f.invoke().result;
  assert.equal(partial.code, 1);
  assert.deepEqual(partial.data.targets.map(t => t.state), ['passed', 'unavailable']);
  assert.equal(partial.data.joint.state, 'pending');
  assert.deepEqual(f.rows(), ['client']);

  fs.renameSync(path.join(f.root, 'away'), path.join(f.root, 'server'));
  const resumed = await f.invoke().result;
  assert.equal(resumed.code, 0);
  assert.equal(resumed.data.targets[0].cached, true);
  assert.equal(resumed.data.targets[0].receipt_id, partial.data.targets[0].receipt_id);
  assert.deepEqual(resumed.data.joint.target_receipts, resumed.data.targets.map(t => t.receipt_id));
  assert.deepEqual(f.rows(), ['client', 'server', 'joint']);
  assert.equal(fs.readFileSync(path.join(f.root, 'client/contract'), 'utf8'), 'user local edit');

  doc.joint.verify = ['node', '-e', f.record('incompatible joint') + 'process.exit(23)'];
  f.save(doc);
  const incompatible = await f.invoke().result;
  assert.equal(incompatible.code, 1);
  assert.ok(incompatible.data.targets.every(t => t.state === 'passed' && !t.cached));
  assert.notEqual(incompatible.data.manifest_id, resumed.data.manifest_id);
  assert.equal(incompatible.data.joint.exit_code, 23);
  const replay = await f.invoke().result;
  assert.equal(replay.data.joint.cached, true);
  assert.equal(replay.data.joint.receipt_id, incompatible.data.joint.receipt_id);
});

test('times out an arbitrary check and never blindly reruns the uncertain operation', async t => {
  const f = fixture(t);
  const target = f.repo('slow', { 'check.js': f.record('once') + 'setTimeout(() => {}, 60000)' });
  // The deadline includes the Git checkout and process startup. Leave time
  // for the verifier to write its witness before exercising the timeout.
  f.save({ version: 1, timeout_seconds: 10, targets: [target], joint: { cwd: 'slow', verify: ['node', '-v'] } });
  const first = await f.invoke().result;
  assert.equal(first.code, 1);
  assert.equal(first.data.targets[0].state, 'uncertain');
  const second = await f.invoke('--retry-failed').result;
  assert.equal(second.data.targets[0].state, 'uncertain');
  assert.deepEqual(f.rows(), ['once']);
});

test('an unavailable retry explains the current outage and preserves the earlier definite failure', async t => {
  const f = fixture(t);
  const target = f.repo('offline', { 'check.js': f.record('tried') + 'process.exit(7)' });
  f.save({ version: 1, targets: [target], joint: { cwd: 'offline', verify: ['node', '-v'] } });
  const first = (await f.invoke().result).data.targets[0];
  assert.equal(first.exit_code, 7);
  const online = path.join(f.root, 'offline');
  const parked = path.join(f.root, 'disconnected');
  fs.renameSync(online, parked);
  const missed = (await f.invoke('--retry-failed').result).data.targets[0];
  assert.equal(missed.state, 'unavailable');
  assert.equal(missed.previous_receipt_id, first.receipt_id);
  assert.match(missed.detail, /offline/);
  assert.equal((await f.invoke().result).data.targets[0].receipt_id, first.receipt_id);
  fs.renameSync(parked, online);
  const retry = (await f.invoke('--retry-failed').result).data.targets[0];
  assert.equal(retry.exit_code, 7);
  assert.notEqual(retry.receipt_id, first.receipt_id);
  assert.equal(f.rows().length, 2);
  const manifestId = (await f.invoke().result).data.manifest_id;
  const ledger = new DatabaseSync(path.join(f.coordinator, '.atris/state/fleet-verify', manifestId + '.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(new Set(ledger.prepare('SELECT receipt_id FROM receipts WHERE name=?').all('offline').map(r => r.receipt_id)),
      new Set([first.receipt_id, retry.receipt_id]));
  } finally {
    ledger.close();
  }
});

test('concurrent coordinators run a verifier only once and recover after owner loss', async t => {
  const f = fixture(t);
  const target = f.repo('worker', { 'check.js': f.record('began') + 'setTimeout(() => {}, 10000)' });
  f.save({ version: 1, targets: [target], joint: { cwd: 'worker', verify: ['node', '-v'] } });
  const owner = f.invoke();
  const until = Date.now() + 7000;
  while (f.rows().length === 0 && Date.now() < until) await delay(20);
  assert.deepEqual(f.rows(), ['began']);
  const simultaneous = await f.invoke().result;
  assert.equal(simultaneous.data.targets[0].state, 'in_progress');
  owner.child.kill('SIGKILL');
  assert.equal((await owner.result).signal, 'SIGKILL');
  const resume = await f.invoke('--retry-failed').result;
  assert.equal(resume.code, 1);
  assert.equal(resume.data.targets[0].state, 'uncertain');
  assert.deepEqual(f.rows(), ['began']);
});

test('a reused live PID cannot keep an expired ticket running or authorize another attempt', async t => {
  const f = fixture(t);
  const target = f.repo('server', { 'check.js': f.record('original') });
  f.save({ version: 1, targets: [target], joint: { cwd: 'server', verify: ['node', '-v'] } });
  const first = (await f.invoke().result).data;
  const db = new DatabaseSync(path.join(f.coordinator, '.atris/state/fleet-verify', first.manifest_id + '.sqlite'));
  try {
    db.prepare("UPDATE tickets SET state='running', pid=?,deadline=?,receipt=NULL WHERE name='server'")
      .run(process.pid, Date.now() - 10000);
  } finally {
    db.close();
  }
  const retry = await f.invoke('--retry-failed').result;
  assert.equal(retry.code, 1);
  assert.equal(retry.data.targets[0].state, 'uncertain');
  assert.deepEqual(f.rows(), ['original']);
});

test('validates target names, exact revisions, command arguments, and joint references before checking', async t => {
  const f = fixture(t);
  const target = f.repo('safe', { 'check.js': f.record('unexpected') });
  for (const overrides of [{ name: '../outside' }, { revision: 'HEAD' }, { verify: 'node check.js' }]) {
    f.save({ version: 1, targets: [{ ...target, ...overrides }], joint: { cwd: 'safe', verify: ['node', '-v'] } });
    const run = await f.invoke().result;
    assert.equal(run.code, 1);
    assert.ok(run.data.error);
  }
  f.save({ version: 1, targets: [target], joint: { cwd: 'safe', verify: ['node', '{repo:absent}'] } });
  assert.match((await f.invoke().result).data.error, /placeholder/);
  f.save({ version: 1, targets: [{ ...target, revision: '0'.repeat(40) }], joint: { cwd: 'safe', verify: ['node', '-v'] } });
  const missing = await f.invoke().result;
  assert.equal(missing.code, 1);
  assert.equal(missing.data.targets[0].state, 'unavailable');
  assert.deepEqual(f.rows(), []);
});

test('receipt keeps a bounded preview and a digest of the complete verifier output', async t => {
  const f = fixture(t);
  const target = f.repo('noisy', { 'check.js': "process.stdout.write('z'.repeat(100000));" });
  f.save({ version: 1, targets: [target], joint: { cwd: 'noisy', verify: ['node', '-v'] } });
  const result = await f.invoke().result;
  assert.equal(result.code, 0);
  const output = result.data.targets[0].stdout;
  assert.equal(output.bytes, 100000);
  assert.ok(output.text.length <= 8192);
  assert.equal(output.sha256, require('node:crypto').createHash('sha256').update('z'.repeat(100000)).digest('hex'));
});

test('overlapping retries can replace the observed failed attempt only once', async t => {
  const f = fixture(t);
  const target = f.repo('server', { 'check.js': f.record('failed check') + 'process.exit(9)' });
  f.save({ version: 1, targets: [target], joint: { cwd: 'server', verify: ['node', '-v'] } });
  assert.equal((await f.invoke().result).data.targets[0].exit_code, 9);

  const bin = path.join(f.root, 'bin');
  const entered = path.join(f.root, 'snapshot-started');
  const release = path.join(f.root, 'resume-snapshot');
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `if (process.argv.includes('--verify') && !fs.existsSync(${JSON.stringify(entered)})) {`,
    `  fs.writeFileSync(${JSON.stringify(entered)}, 'started');`,
    '  const until = Date.now() + 5000;',
    `  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) {`,
    '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    '  }',
    '}',
    `const run = require('node:child_process').spawnSync(${JSON.stringify(git)}, process.argv.slice(2), { stdio: 'inherit' });`,
    'process.exit(run.status ?? 1);',
  ].join('\n'), { mode: 0o755 });

  const slow = f.invokeWith({ PATH: bin + path.delimiter + process.env.PATH }, '--retry-failed');
  const until = Date.now() + 4000;
  while (!fs.existsSync(entered) && Date.now() < until) await delay(20);
  assert.ok(fs.existsSync(entered), 'slow coordinator must have observed the initial failure');
  const fast = await f.invoke('--retry-failed').result;
  fs.writeFileSync(release, 'resume');
  const other = await slow.result;
  assert.equal(fast.data.targets[0].exit_code, 9);
  assert.equal(other.data.targets[0].cached, true);
  assert.equal(other.data.targets[0].receipt_id, fast.data.targets[0].receipt_id);
  assert.deepEqual(f.rows(), ['failed check', 'failed check']);
  assert.equal((await f.invoke('--retry-failed').result).data.targets[0].cached, false);
  assert.equal(f.rows().length, 3);
});
