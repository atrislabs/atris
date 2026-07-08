const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const close = require('../commands/close');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function capture(fn) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  try {
    const code = fn();
    return {
      code,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function runClose(args, cwd, now) {
  return capture(() => close.run(args, { cwd, now }));
}

function readLedger(dir) {
  const file = close.ledgerPath(dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, 'close', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CI: 'true',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('add writes an opened event and dedupes an identical open loop', () => {
  const dir = makeTempDir();
  try {
    const added = runClose([
      'add',
      'Send invoice',
      '--owner',
      'you',
      '--lane',
      'life',
      '--ttl',
      '1',
      '--when',
      'the invoice is paid',
      '--source',
      'manual test',
    ], dir, '2026-01-01T00:00:00.000Z');

    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /^opened close-send-invoice-[a-f0-9]{7}$/);
    const id = added.stdout.split(' ')[1];
    assert.equal(id, close.closeIdForWhat('send invoice'));

    const firstLedger = readLedger(dir);
    assert.equal(firstLedger.length, 1);
    assert.deepEqual(firstLedger[0], {
      kind: 'opened',
      at: '2026-01-01T00:00:00.000Z',
      id,
      what: 'Send invoice',
      owner: 'you',
      lane: 'life',
      opened_at: '2026-01-01T00:00:00.000Z',
      ttl_days: 1,
      close_condition: 'the invoice is paid',
      source: 'manual test',
    });

    const duplicate = runClose(['add', 'send invoice'], dir, '2026-01-02T00:00:00.000Z');
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(duplicate.stdout, `already open: ${id}`);
    assert.equal(readLedger(dir).length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('list folds open state, filters lanes, and sorts overdue loops first', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'Pay contractor', '--lane', 'business', '--ttl', '1'], dir, '2026-01-01T00:00:00.000Z');
    runClose(['add', 'Fix flaky test', '--lane', 'code', '--ttl', '5'], dir, '2026-01-03T00:00:00.000Z');
    runClose(['add', 'Book dentist', '--lane', 'life', '--ttl', '2'], dir, '2026-01-02T00:00:00.000Z');

    const listed = runClose(['list'], dir, '2026-01-04T00:00:00.000Z');
    assert.equal(listed.code, 0, listed.stderr);
    const lines = listed.stdout.split('\n');
    assert.equal(lines[0], 'pay contractor, 3 days old, 2 days past ttl');
    assert.equal(lines[1], 'book dentist, 2 days old, 0 days past ttl');
    assert.equal(lines[2], 'fix flaky test, 1 day old');

    const json = runClose(['list', '--json', '--lane', 'code'], dir, '2026-01-04T00:00:00.000Z');
    assert.equal(json.code, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.open.length, 1);
    assert.equal(payload.open[0].what, 'Fix flaky test');
    assert.equal(payload.open[0].lane, 'code');
  } finally {
    cleanupTempDir(dir);
  }
});

test('done and dissolve remove loops from the folded open view', () => {
  const dir = makeTempDir();
  try {
    const first = runClose(['add', 'Ship renewal note'], dir, '2026-02-01T00:00:00.000Z');
    const firstId = first.stdout.split(' ')[1];
    const done = runClose(['done', firstId, '--proof', 'sent'], dir, '2026-02-02T00:00:00.000Z');
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout, `closed ${firstId}`);
    assert.equal(close.openFlags(dir, { now: '2026-02-03T00:00:00.000Z' }).length, 0);

    const second = runClose(['add', 'Try dead idea'], dir, '2026-02-03T00:00:00.000Z');
    const secondId = second.stdout.split(' ')[1];
    const missingWhy = runClose(['dissolve', secondId], dir, '2026-02-04T00:00:00.000Z');
    assert.equal(missingWhy.code, 2);
    assert.equal(missingWhy.stderr, 'error: why is required');

    const dissolved = runClose(['dissolve', secondId, '--why', 'not worth doing'], dir, '2026-02-04T00:00:00.000Z');
    assert.equal(dissolved.code, 0, dissolved.stderr);
    assert.equal(dissolved.stdout, `dissolved ${secondId}`);
    assert.equal(close.openFlags(dir, { now: '2026-02-05T00:00:00.000Z' }).length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('snooze extends the effective due date without rewriting history', () => {
  const dir = makeTempDir();
  try {
    const added = runClose(['add', 'Renew passport', '--ttl', '1'], dir, '2026-03-01T00:00:00.000Z');
    const id = added.stdout.split(' ')[1];
    const snoozed = runClose(['snooze', id, '--days', '2'], dir, '2026-03-03T00:00:00.000Z');
    assert.equal(snoozed.code, 0, snoozed.stderr);
    assert.equal(snoozed.stdout, `snoozed ${id} for 2 days`);
    assert.equal(readLedger(dir).length, 2);

    const before = runClose(['sweep'], dir, '2026-03-04T00:00:00.000Z');
    assert.equal(before.code, 0, before.stderr);
    assert.equal(before.stdout, 'nothing is overdue.');

    const after = runClose(['list'], dir, '2026-03-06T00:00:00.000Z');
    assert.equal(after.stdout, 'renew passport, 5 days old, 1 day past ttl');
  } finally {
    cleanupTempDir(dir);
  }
});

test('sweep prints operator sentences and escalates once per day per loop', () => {
  const dir = makeTempDir();
  try {
    runClose(['add', 'Approve payroll', '--owner', 'you', '--ttl', '1', '--when', 'payroll is approved'], dir, '2026-04-01T00:00:00.000Z');
    runClose(['add', 'Vendor reply', '--owner', 'sam', '--ttl', '1', '--when', 'the vendor has answered'], dir, '2026-04-01T00:00:00.000Z');

    const sweep = runClose(['sweep'], dir, '2026-04-04T00:00:00.000Z');
    assert.equal(sweep.code, 0, sweep.stderr);
    const lines = sweep.stdout.split('\n');
    assert.equal(lines[0], 'approve payroll is waiting on you, 2 days late, close it when payroll is approved.');
    assert.equal(lines[1], 'sam owns vendor reply, 2 days late, close it when the vendor has answered.');
    assert.doesNotMatch(sweep.stdout, /close-/);
    assert.doesNotMatch(sweep.stdout, /\bflag\b|\bttl\b/);

    const afterFirstSweep = readLedger(dir).filter((event) => event.kind === 'escalated');
    assert.equal(afterFirstSweep.length, 2);

    const json = runClose(['sweep', '--json'], dir, '2026-04-04T12:00:00.000Z');
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      open: 2,
      overdue: 2,
      escalated_today: [],
    });
    assert.equal(readLedger(dir).filter((event) => event.kind === 'escalated').length, 2);

    runClose(['sweep'], dir, '2026-04-05T00:00:00.000Z');
    assert.equal(readLedger(dir).filter((event) => event.kind === 'escalated').length, 4);
  } finally {
    cleanupTempDir(dir);
  }
});

test('cli smoke writes and folds the jsonl ledger in a temp workspace', () => {
  const dir = makeTempDir();
  try {
    const add = runCli(['add', 'Follow up with buyer', '--ttl', '1'], dir);
    assert.equal(add.status, 0, add.stderr || add.stdout);
    assert.match(add.stdout.trim(), /^opened close-follow-up-with-buyer-[a-f0-9]{7}$/);

    const list = runCli(['list', '--json'], dir);
    assert.equal(list.status, 0, list.stderr || list.stdout);
    const payload = JSON.parse(list.stdout);
    assert.equal(payload.open.length, 1);
    assert.equal(payload.open[0].what, 'Follow up with buyer');

    const sweep = runCli(['sweep', '--json'], dir);
    assert.equal(sweep.status, 0, sweep.stderr || sweep.stdout);
    const sweepPayload = JSON.parse(sweep.stdout);
    assert.equal(sweepPayload.open, 1);
    assert.equal(typeof sweepPayload.overdue, 'number');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'closure.jsonl')));
  } finally {
    cleanupTempDir(dir);
  }
});
