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

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
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

test('scan opens stale review and failed task flags by source and dedupes them', () => {
  const dir = makeTempDir();
  const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
  const now = '2026-01-10T00:00:00.000Z';
  try {
    const tasks = [
      {
        id: 'task-review-old',
        display_id: 'T-1',
        title: 'Old review',
        status: 'review',
        updated_at: '2026-01-04T23:59:58.000Z',
        review: {
          approval_status: 'pending',
          agent_certified: true,
        },
      },
      {
        id: 'task-review-recent',
        display_id: 'T-2',
        title: 'Recent review',
        status: 'review',
        updated_at: '2026-01-09T00:00:00.000Z',
        review: {
          approval_status: 'pending',
          agent_certified: true,
        },
      },
      {
        id: 'task-failed-old',
        display_id: 'T-3',
        title: 'Old failure',
        status: 'failed',
        updated_at: '2026-01-07T23:59:58.000Z',
      },
      {
        id: 'task-done-old',
        display_id: 'T-4',
        title: 'Done work',
        status: 'done',
        updated_at: '2026-01-01T00:00:00.000Z',
        review: {
          approval_status: 'accepted',
        },
      },
    ];
    writeJson(projectionPath, { schema: 'test', tasks });

    const scan = runClose(['scan'], dir, now);
    assert.equal(scan.code, 0, scan.stderr);
    assert.deepEqual(scan.stdout.split('\n'), [
      'opened task t-1 has waited in review too long, accept it or send it back.',
      'opened task t-3 failed and nobody looked, retry it or dissolve it.',
    ]);

    const opened = readLedger(dir).filter((event) => event.kind === 'opened');
    assert.equal(opened.length, 2);
    assert.deepEqual(opened.map((event) => event.source).sort(), ['task:task-failed-old', 'task:task-review-old']);
    assert.equal(opened.every((event) => event.lane === 'code' && event.ttl_days === 3), true);

    const duplicate = runClose(['scan'], dir, now);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(duplicate.stdout, 'nothing new to open, nothing resolved.');
    assert.equal(readLedger(dir).filter((event) => event.kind === 'opened').length, 2);

    tasks[0].status = 'done';
    tasks[0].review.approval_status = 'accepted';
    writeJson(projectionPath, { schema: 'test', tasks });
    const resolved = runClose(['scan'], dir, now);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.equal(resolved.stdout, 'auto-closed task t-1 has waited in review too long, accept it or send it back.');
    const closed = readLedger(dir).filter((event) => event.kind === 'closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].proof, 'resolved in source store');
  } finally {
    cleanupTempDir(dir);
  }
});

test('scan caps dead mission flags and reports skipped stale missions', () => {
  const dir = makeTempDir();
  const missionsPath = path.join(dir, '.atris', 'state', 'missions.jsonl');
  try {
    const missions = Array.from({ length: 12 }, (_, index) => ({
      id: `mission-${index + 1}`,
      objective: `old mission ${index + 1}`,
      owner: 'codex',
      status: index % 2 === 0 ? 'running' : 'planning',
      updated_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    writeJsonl(missionsPath, missions);

    const scan = runClose(['scan'], dir, '2026-01-20T00:00:00.000Z');
    assert.equal(scan.code, 0, scan.stderr);
    const lines = scan.stdout.split('\n');
    assert.equal(lines.filter((line) => line.startsWith('opened mission old mission')).length, 10);
    assert.equal(lines.at(-1), 'skipped 2 stale missions due to cap.');
    const opened = readLedger(dir).filter((event) => event.kind === 'opened' && event.source.startsWith('mission:'));
    assert.equal(opened.length, 10);
    assert.equal(opened[0].source, 'mission:mission-1');
    assert.equal(opened[9].source, 'mission:mission-10');
  } finally {
    cleanupTempDir(dir);
  }
});

test('scan auto-closes mission flags when the mission resolves', () => {
  const dir = makeTempDir();
  const missionsPath = path.join(dir, '.atris', 'state', 'missions.jsonl');
  try {
    writeJsonl(missionsPath, [{
      id: 'mission-resolved',
      objective: 'resolve source mission',
      owner: 'codex',
      status: 'running',
      updated_at: '2026-01-01T00:00:00.000Z',
    }]);
    const opened = runClose(['scan'], dir, '2026-01-10T00:00:00.000Z');
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(readLedger(dir).filter((event) => event.kind === 'opened').length, 1);

    writeJsonl(missionsPath, [{
      id: 'mission-resolved',
      objective: 'resolve source mission',
      owner: 'codex',
      status: 'stopped',
      updated_at: '2026-01-11T00:00:00.000Z',
    }]);
    const closed = runClose(['scan'], dir, '2026-01-11T00:00:00.000Z');
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(closed.stdout, 'auto-closed mission resolve source mission has not moved in days, resume it or stop it.');
    const closedEvents = readLedger(dir).filter((event) => event.kind === 'closed');
    assert.equal(closedEvents.length, 1);
    assert.equal(closedEvents[0].proof, 'resolved in source store');
  } finally {
    cleanupTempDir(dir);
  }
});

test('scan opens and resolves watch file flags from relative and absolute paths', () => {
  const dir = makeTempDir();
  const watchPath = path.join(dir, '.atris', 'close-watch.json');
  const absolutePath = path.join(dir, 'outside.log');
  try {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'todo close this loose end\n');
    fs.writeFileSync(absolutePath, 'blocked by external signal\n');
    writeJson(watchPath, [
      {
        path: 'notes.md',
        pattern: 'todo close',
        lane: 'life',
        ttl_days: 2,
        what: 'notes has close todo',
      },
      {
        path: absolutePath,
        pattern: 'blocked',
        lane: 'code',
        ttl_days: 4,
        what: 'external blocker is present',
      },
      {
        path: 'missing.md',
        pattern: 'never',
        lane: 'code',
        ttl_days: 1,
        what: 'missing watch should skip',
      },
    ]);

    const scan = runClose(['scan', '--json'], dir, '2026-02-01T00:00:00.000Z');
    assert.equal(scan.code, 0, scan.stderr);
    const payload = JSON.parse(scan.stdout);
    assert.equal(payload.counts.opened, 2);
    assert.equal(payload.counts.auto_closed, 0);
    assert.deepEqual(payload.opened.map((event) => event.source).sort(), [
      `watch:${absolutePath}`,
      'watch:notes.md',
    ]);
    const notesFlag = payload.opened.find((event) => event.source === 'watch:notes.md');
    assert.equal(notesFlag.lane, 'life');
    assert.equal(notesFlag.ttl_days, 2);

    fs.writeFileSync(path.join(dir, 'notes.md'), 'the loose end is clear\n');
    const resolved = runClose(['scan'], dir, '2026-02-02T00:00:00.000Z');
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.equal(resolved.stdout, 'auto-closed notes has close todo.');
    const closed = readLedger(dir).filter((event) => event.kind === 'closed');
    assert.equal(closed.length, 1);
    assert.equal(closed[0].proof, 'resolved in source store');
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
