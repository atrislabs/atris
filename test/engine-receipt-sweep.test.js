'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { engineCommand } = require('../commands/engine');
const { sweepEngineAskReceipts } = require('../lib/engine-receipt-sweep');

const NOW = '2026-08-12T12:00:00.000Z';
const OLD = '2026-08-12T11:40:00.000Z';
const YOUNG = '2026-08-12T11:55:00.000Z';
const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function tempRoot(prefix = 'atris-engine-receipt-sweep-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function receiptPath(root, name) {
  return path.join(root, 'atris', 'runs', `${name}.json`);
}

function writeReceipt(root, name, receipt) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const value = {
    schema: 'atris.engine_ask_receipt.v1',
    started_at: OLD,
    at: OLD,
    status: 'running',
    pid: 424242,
    engine: 'codex',
    ...receipt,
  };
  if (value.live_log) fs.writeFileSync(path.join(root, value.live_log), 'last words\n');
  fs.writeFileSync(receiptPath(root, name), `${JSON.stringify(value, null, 2)}\n`);
  return receiptPath(root, name);
}

function readReceipt(root, name) {
  return JSON.parse(fs.readFileSync(receiptPath(root, name), 'utf8'));
}

function deadPidError() {
  return Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

function sweepAtNow(root, extra = {}) {
  return sweepEngineAskReceipts(root, { now: () => new Date(NOW), ...extra });
}

test('stale receipt sweep finalizes a dead-pid running receipt atomically and watch reads it as final', async () => {
  const root = tempRoot();
  const output = [];
  try {
    const liveLog = path.join('atris', 'runs', 'engine-ask-dead.live.log');
    writeReceipt(root, 'engine-ask-dead', { live_log: liveLog });

    const summary = sweepAtNow(root, { kill: () => { throw deadPidError(); } });
    const receipt = readReceipt(root, 'engine-ask-dead');
    assert.deepEqual(summary, { scanned: 1, finalized: 1, skipped_alive: 0, skipped_young: 0 });
    assert.equal(receipt.status, 'presumed_dead');
    assert.equal(receipt.swept_at, NOW);
    assert.match(receipt.note, /stale receipt sweep/);
    assert.equal(receipt.note.includes('\n'), false);
    assert.equal(fs.readdirSync(path.dirname(receiptPath(root, 'engine-ask-dead'))).some((name) => name.endsWith('.tmp')), false);

    const code = await engineCommand(['watch', 'latest', '--no-follow'], {
      root,
      engineWatch: { log: (line = '') => output.push(String(line)), pidIsAlive: () => false },
    });
    assert.equal(code, 0);
    assert.match(output[0], /presumed_dead/);
    assert.doesNotMatch(output[0], /\srunning\s/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale receipt sweep leaves an alive-pid receipt untouched', () => {
  const root = tempRoot();
  try {
    const file = writeReceipt(root, 'engine-ask-alive', { pid: process.pid });
    const before = fs.readFileSync(file, 'utf8');
    const summary = sweepAtNow(root);
    assert.deepEqual(summary, { scanned: 1, finalized: 0, skipped_alive: 1, skipped_young: 0 });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale receipt sweep treats a permission error as an alive pid', () => {
  const root = tempRoot();
  try {
    const file = writeReceipt(root, 'engine-ask-protected', { pid: 31337 });
    const before = fs.readFileSync(file, 'utf8');
    const summary = sweepAtNow(root, {
      kill: () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); },
    });
    assert.deepEqual(summary, { scanned: 1, finalized: 0, skipped_alive: 1, skipped_young: 0 });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale receipt sweep leaves a young running receipt untouched', () => {
  const root = tempRoot();
  let killCalls = 0;
  try {
    const file = writeReceipt(root, 'engine-ask-young', { started_at: YOUNG, at: YOUNG });
    const before = fs.readFileSync(file, 'utf8');
    const summary = sweepAtNow(root, { kill: () => { killCalls += 1; throw deadPidError(); } });
    assert.deepEqual(summary, { scanned: 1, finalized: 0, skipped_alive: 0, skipped_young: 1 });
    assert.equal(killCalls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale receipt sweep leaves non-running receipts untouched', () => {
  const root = tempRoot();
  let killCalls = 0;
  try {
    const file = writeReceipt(root, 'engine-ask-done', { status: 'completed' });
    const before = fs.readFileSync(file, 'utf8');
    const summary = sweepAtNow(root, { kill: () => { killCalls += 1; throw deadPidError(); } });
    assert.deepEqual(summary, { scanned: 0, finalized: 0, skipped_alive: 0, skipped_young: 0 });
    assert.equal(killCalls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale receipt sweep skips malformed receipt json without crashing', () => {
  const root = tempRoot();
  try {
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const file = path.join(runsDir, 'engine-ask-broken.json');
    fs.writeFileSync(file, '{not json\n');
    assert.deepEqual(sweepAtNow(root), { scanned: 0, finalized: 0, skipped_alive: 0, skipped_young: 0 });
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale receipt sweep summary counts running ask receipts by outcome', () => {
  const root = tempRoot();
  try {
    writeReceipt(root, 'engine-ask-dead', { pid: 111 });
    writeReceipt(root, 'engine-ask-alive', { pid: process.pid });
    writeReceipt(root, 'engine-ask-young', { pid: 222, started_at: YOUNG, at: YOUNG });
    writeReceipt(root, 'engine-ask-done', { status: 'failed', pid: 333 });
    fs.writeFileSync(receiptPath(root, 'engine-ask-malformed'), '{bad json\n');

    const summary = sweepAtNow(root, {
      kill: (pid, signal) => {
        if (pid === process.pid) return process.kill(pid, signal);
        throw deadPidError();
      },
    });
    assert.deepEqual(summary, { scanned: 3, finalized: 1, skipped_alive: 1, skipped_young: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hourly autoland narration names finalized stale receipts and stays silent on the next tick', () => {
  const root = tempRoot('atris-engine-receipt-autoland-');
  try {
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root }).status, 0);
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    assert.equal(spawnSync('git', ['add', 'README.md'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: root }).status, 0);
    const policyDir = path.join(root, '.atris', 'policy');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(path.join(policyDir, 'autoland.json'), `${JSON.stringify({
      enabled: true,
      enabled_by: 'test',
      daily_experiment: false,
      janitor: false,
      digest_hour: -1,
    }, null, 2)}\n`);
    writeReceipt(root, 'engine-ask-dead', { pid: 99_999_999, started_at: '2020-01-01T00:00:00.000Z', at: '2020-01-01T00:00:00.000Z' });

    const env = {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_TASKS_DB: path.join(root, '.atris', 'fixture-tasks.db'),
      CI: 'true',
    };
    delete env.CLAUDECODE;
    delete env.CODEX_SANDBOX;
    delete env.CURSOR_AGENT;
    delete env.DEVIN_SESSION_ID;
    delete env.ATRIS_AGENT_PROOF_ONLY;
    const first = spawnSync(process.execPath, [cliPath, 'autoland', 'tick'], { cwd: root, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /finalized 1 stale engine receipt as presumed dead/);
    assert.equal(readReceipt(root, 'engine-ask-dead').status, 'presumed_dead');

    const second = spawnSync(process.execPath, [cliPath, 'autoland', 'tick'], { cwd: root, encoding: 'utf8', timeout: 30_000, env });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.doesNotMatch(second.stdout, /stale engine receipt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
