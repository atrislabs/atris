const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const close = require('../commands/close');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-park-test-'));
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
    return {
      code: fn(),
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
  return fs.readFileSync(file, 'utf8')
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeLedger(dir, events) {
  const file = close.ledgerPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

test('park, parked, and reopen preserve loop fields and history', () => {
  const dir = makeTempDir();
  try {
    const added = runClose([
      'add',
      'Send renewal',
      '--owner',
      'sam',
      '--lane',
      'business',
      '--ttl',
      '9',
      '--when',
      'the renewal is signed',
      '--source',
      'manual test',
    ], dir, '2026-01-01T00:00:00.000Z');
    const id = added.stdout.split(' ')[1];
    runClose(['snooze', id, '--days', '2'], dir, '2026-01-02T00:00:00.000Z');

    const parked = runClose(['park', id, '--why', 'waiting for the next quarter'], dir, '2026-01-03T00:00:00.000Z');
    assert.equal(parked.code, 0, parked.stderr);
    assert.equal(parked.stdout, `parked ${id}`);
    assert.equal(close.openFlags(dir, { now: '2026-01-03T00:00:00.000Z' }).length, 0);

    const parkedFlag = close.parkedFlags(dir, { now: '2026-01-03T00:00:00.000Z' })[0];
    assert.equal(parkedFlag.id, id);
    assert.equal(parkedFlag.owner, 'sam');
    assert.equal(parkedFlag.lane, 'business');
    assert.equal(parkedFlag.ttl_days, 9);
    assert.equal(parkedFlag.close_condition, 'the renewal is signed');
    assert.equal(parkedFlag.source, 'manual test');
    assert.equal(parkedFlag.snoozed_until, '2026-01-04T00:00:00.000Z');
    assert.equal(parkedFlag.parked_at, '2026-01-03T00:00:00.000Z');
    assert.equal(parkedFlag.why, 'waiting for the next quarter');
    assert.deepEqual(parkedFlag.events.map((event) => event.kind), ['opened', 'snoozed', 'parked']);

    const listed = runClose(['parked', '--json'], dir, '2026-01-03T00:00:00.000Z');
    assert.equal(listed.code, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    assert.equal(payload.parked.length, 1);
    assert.equal(payload.parked[0].parked_at, '2026-01-03T00:00:00.000Z');
    assert.equal(payload.parked[0].why, 'waiting for the next quarter');

    const reopened = runClose(['reopen', id], dir, '2026-01-05T00:00:00.000Z');
    assert.equal(reopened.code, 0, reopened.stderr);
    assert.equal(reopened.stdout, `reopened ${id}`);
    assert.equal(close.parkedFlags(dir, { now: '2026-01-05T00:00:00.000Z' }).length, 0);
    const openFlag = close.openFlags(dir, { now: '2026-01-05T00:00:00.000Z' })[0];
    assert.equal(openFlag.what, 'Send renewal');
    assert.equal(openFlag.owner, 'sam');
    assert.equal(openFlag.snoozed_until, '2026-01-04T00:00:00.000Z');
    assert.deepEqual(openFlag.events.map((event) => event.kind), ['opened', 'snoozed', 'parked', 'reopened']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('ten open slots refuse add and reopen unless replace parks one first', () => {
  const dir = makeTempDir();
  try {
    const ids = [];
    for (let index = 1; index <= 10; index += 1) {
      const day = String(index).padStart(2, '0');
      const added = runClose(['add', `Loop ${index}`], dir, `2026-02-${day}T00:00:00.000Z`);
      assert.equal(added.code, 0, added.stderr);
      ids.push(added.stdout.split(' ')[1]);
    }

    const refused = runClose(['add', 'Eleventh loop'], dir, '2026-02-20T00:00:00.000Z');
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /ten open loops is the cap/);
    assert.match(refused.stderr, /fullest loops are loop 1/);
    assert.equal(close.openFlags(dir).length, 10);

    const replaced = runClose([
      'add',
      'Eleventh loop',
      '--replace',
      ids[0],
    ], dir, '2026-02-20T00:00:00.000Z');
    assert.equal(replaced.code, 0, replaced.stderr);
    const eleventhId = replaced.stdout.split(' ')[1];
    assert.equal(close.openFlags(dir).length, 10);
    assert.deepEqual(close.parkedFlags(dir).map((flag) => flag.id), [ids[0]]);

    const reopenRefused = runClose(['reopen', ids[0]], dir, '2026-02-21T00:00:00.000Z');
    assert.equal(reopenRefused.code, 2);
    assert.match(reopenRefused.stderr, /ten open loops is the cap/);

    const reopenReplaced = runClose([
      'reopen',
      ids[0],
      '--replace',
      eleventhId,
    ], dir, '2026-02-21T00:00:00.000Z');
    assert.equal(reopenReplaced.code, 0, reopenReplaced.stderr);
    assert.equal(close.openFlags(dir).length, 10);
    assert.deepEqual(close.parkedFlags(dir).map((flag) => flag.id), [eleventhId]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('first list parks the oldest five of fifteen seeded open loops', () => {
  const dir = makeTempDir();
  try {
    const opened = [];
    for (let index = 1; index <= 15; index += 1) {
      const day = String(index).padStart(2, '0');
      const at = `2026-03-${day}T00:00:00.000Z`;
      opened.push({
        kind: 'opened',
        at,
        id: `close-seeded-${day}`,
        what: `Pending loop ${day}`,
        owner: 'operator',
        lane: 'business',
        opened_at: at,
        ttl_days: 30,
        close_condition: 'the loop is resolved',
        source: 'manual',
      });
    }
    writeLedger(dir, opened);

    const listed = runClose(['list'], dir, '2026-03-20T00:00:00.000Z');
    assert.equal(listed.code, 0, listed.stderr);
    const parkedLines = listed.stdout.split('\n').filter((line) => line.startsWith('parked '));
    assert.equal(parkedLines.length, 5);
    assert.equal(parkedLines[0], 'parked pending loop 01: waiting on a human.');
    assert.equal(parkedLines[4], 'parked pending loop 05: waiting on a human.');

    assert.deepEqual(
      close.parkedFlags(dir).map((flag) => flag.id).sort(),
      ['close-seeded-01', 'close-seeded-02', 'close-seeded-03', 'close-seeded-04', 'close-seeded-05']
    );
    assert.deepEqual(
      close.openFlags(dir).map((flag) => flag.id).sort(),
      ['close-seeded-06', 'close-seeded-07', 'close-seeded-08', 'close-seeded-09', 'close-seeded-10',
        'close-seeded-11', 'close-seeded-12', 'close-seeded-13', 'close-seeded-14', 'close-seeded-15']
    );
    assert.equal(readLedger(dir).filter((event) => event.kind === 'opened').length, 15);
    assert.equal(readLedger(dir).filter((event) => event.kind === 'parked').length, 5);

    runClose(['list'], dir, '2026-03-20T01:00:00.000Z');
    assert.equal(readLedger(dir).filter((event) => event.kind === 'parked').length, 5);
  } finally {
    cleanupTempDir(dir);
  }
});
