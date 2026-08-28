const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const close = require('../commands/close');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-zombie-test-'));
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
    return { code: fn(), stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function writeLedger(dir, events) {
  const file = close.ledgerPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

function readLedger(dir) {
  return fs.readFileSync(close.ledgerPath(dir), 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function reviewReminder({ id, taskId, ref, at = '2026-08-01T00:00:00.000Z' }) {
  return {
    kind: 'opened',
    at,
    id,
    what: `task ${ref} has waited in review too long, accept it or send it back`,
    owner: 'operator',
    lane: 'code',
    opened_at: at,
    ttl_days: 3,
    close_condition: 'the source store resolves it',
    source: `task:${taskId}`,
  };
}

test('sweep closes a resolved task review reminder and keeps an open task reminder', () => {
  const dir = makeTempDir();
  const now = '2026-08-28T20:00:00.000Z';
  try {
    writeJson(path.join(dir, '.atris', 'state', 'tasks.projection.json'), {
      tasks: [
        {
          id: '01k-closed-task',
          display_id: 'CLI-1180',
          status: 'done',
          metadata: { approval_status: 'accepted' },
        },
        {
          id: '01k-open-task',
          display_id: 'CLI-1181',
          status: 'review',
          review: { approval_status: 'pending' },
        },
      ],
    });
    writeLedger(dir, [
      reviewReminder({ id: 'close-task-01k-closed-task-a1b2c3d', taskId: '01k-closed-task', ref: 'CLI-1180' }),
      reviewReminder({ id: 'close-task-01k-open-task-b2c3d4e', taskId: '01k-open-task', ref: 'CLI-1181' }),
    ]);

    const result = capture(() => close.run(['sweep'], { cwd: dir, now }));

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.split('\n'), [
      'auto-closed review reminder for task cli-1180.',
      'task cli-1181 has waited in review too long, accept it or send it back is waiting on you, 24 days late, close it when the source store resolves it.',
    ]);
    const events = readLedger(dir);
    assert.deepEqual(events.filter((event) => event.kind === 'closed'), [{
      kind: 'closed',
      at: now,
      id: 'close-task-01k-closed-task-a1b2c3d',
      proof: 'task cli-1180 is closed in task projection',
    }]);
    assert.equal(close.openFlags(dir, { now }).some((flag) => flag.source === 'task:01k-open-task'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('list closes a parked review reminder when the watched task is closed', () => {
  const dir = makeTempDir();
  const now = '2026-08-28T20:00:00.000Z';
  const id = 'close-task-01k-parked-task-c3d4e5f';
  try {
    writeJson(path.join(dir, '.atris', 'state', 'tasks.projection.json'), {
      tasks: [{ id: '01k-parked-task', display_id: 'CLI-1182', status: 'closed' }],
    });
    writeLedger(dir, [
      reviewReminder({ id, taskId: '01k-parked-task', ref: 'CLI-1182' }),
      { kind: 'parked', at: '2026-08-10T00:00:00.000Z', id, why: 'waiting for approval' },
    ]);

    const result = capture(() => close.run(['list'], { cwd: dir, now }));

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'auto-closed review reminder for task cli-1182.');
    assert.equal(close.parkedFlags(dir, { now }).length, 0);
    assert.equal(readLedger(dir).at(-1).proof, 'task cli-1182 is closed in task projection');
  } finally {
    cleanupTempDir(dir);
  }
});

test('sweep survives missing and corrupt task projections without closing the reminder', async (t) => {
  for (const fixture of ['missing', 'corrupt']) {
    await t.test(fixture, () => {
      const dir = makeTempDir();
      const now = '2026-08-28T20:00:00.000Z';
      try {
        if (fixture === 'corrupt') {
          const projection = path.join(dir, '.atris', 'state', 'tasks.projection.json');
          fs.mkdirSync(path.dirname(projection), { recursive: true });
          fs.writeFileSync(projection, '{not json');
        }
        writeLedger(dir, [reviewReminder({
          id: `close-task-01k-${fixture}-d4e5f6a`,
          taskId: `01k-${fixture}`,
          ref: 'CLI-1183',
        })]);

        const result = capture(() => close.run(['sweep'], { cwd: dir, now }));

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^task cli-1183 has waited in review too long/);
        assert.equal(readLedger(dir).some((event) => event.kind === 'closed'), false);
        assert.equal(close.openFlags(dir, { now }).length, 1);
      } finally {
        cleanupTempDir(dir);
      }
    });
  }
});
