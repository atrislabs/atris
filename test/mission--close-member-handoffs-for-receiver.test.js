'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { closeMemberHandoffsForReceiver } = require('../commands/mission');

const TMP_ROOTS = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-close-handoffs-'));
  TMP_ROOTS.push(root);
  return root;
}

function stateDir(root) {
  return path.join(root, '.atris', 'state');
}

function handoffsPath(root) {
  return path.join(stateDir(root), 'member-handoffs.jsonl');
}

function writeHandoffs(root, lines) {
  fs.mkdirSync(stateDir(root), { recursive: true });
  fs.writeFileSync(handoffsPath(root), `${lines.join('\n')}\n`, 'utf8');
}

function readLines(root) {
  return fs.readFileSync(handoffsPath(root), 'utf8').split('\n').filter((l) => l.trim());
}

function handoff(id, from, to, status, extra = {}) {
  const row = {
    id,
    from,
    to,
    summary: `${from} passes work to ${to}`,
    next_command: `atris member go ${to}`,
    created_at: '2026-01-02T03:04:05.000Z',
    ...extra,
  };
  if (status !== undefined) row.status = status;
  return JSON.stringify(row);
}

test.after(() => {
  for (const root of TMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('closes every open handoff for the receiver and leaves other rows alone', () => {
  const root = makeRoot();
  writeHandoffs(root, [
    handoff('h1', 'navigator', 'executor', 'open'),
    handoff('h2', 'architect', 'executor', 'open'),
    handoff('h3', 'executor', 'validator', 'open'),
    handoff('h4', 'navigator', 'executor', 'closed', { closed_at: '2026-01-01T00:00:00.000Z' }),
  ]);

  const closed = closeMemberHandoffsForReceiver('executor', root);
  assert.strictEqual(closed, 2);

  const rows = readLines(root).map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.id), ['h1', 'h2', 'h3', 'h4']);

  assert.strictEqual(rows[0].status, 'closed');
  assert.strictEqual(rows[1].status, 'closed');
  assert.strictEqual(typeof rows[0].closed_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(rows[0].closed_at)), 'closed_at should be an ISO timestamp');

  // Original fields survive the rewrite.
  assert.strictEqual(rows[0].from, 'navigator');
  assert.strictEqual(rows[0].to, 'executor');
  assert.strictEqual(rows[0].summary, 'navigator passes work to executor');
  assert.strictEqual(rows[0].created_at, '2026-01-02T03:04:05.000Z');

  // A different receiver stays open and untouched.
  assert.strictEqual(rows[2].status, 'open');
  assert.strictEqual(rows[2].closed_at, undefined);

  // An already closed row keeps its original close time.
  assert.strictEqual(rows[3].status, 'closed');
  assert.strictEqual(rows[3].closed_at, '2026-01-01T00:00:00.000Z');
});

test('matches the receiver ignoring case and surrounding spaces', () => {
  const root = makeRoot();
  writeHandoffs(root, [
    handoff('h1', 'navigator', 'Executor', 'open'),
    handoff('h2', 'navigator', 'executor', 'open'),
  ]);

  const closed = closeMemberHandoffsForReceiver('  EXECUTOR  ', root);
  assert.strictEqual(closed, 2);
  const rows = readLines(root).map((l) => JSON.parse(l));
  assert.deepStrictEqual(rows.map((r) => r.status), ['closed', 'closed']);
});

test('a row with no status counts as open and gets closed', () => {
  const root = makeRoot();
  writeHandoffs(root, [handoff('h1', 'navigator', 'executor', undefined)]);

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 1);
  const [row] = readLines(root).map((l) => JSON.parse(l));
  assert.strictEqual(row.status, 'closed');
  assert.strictEqual(typeof row.closed_at, 'string');
});

test('rows with any status other than open are not touched', () => {
  const root = makeRoot();
  const lines = [
    handoff('h1', 'navigator', 'executor', 'closed', { closed_at: '2026-01-01T00:00:00.000Z' }),
    handoff('h2', 'navigator', 'executor', 'done'),
    handoff('h3', 'navigator', 'executor', 'cancelled'),
  ];
  writeHandoffs(root, lines);
  const before = fs.readFileSync(handoffsPath(root), 'utf8');

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 0);
  assert.strictEqual(fs.readFileSync(handoffsPath(root), 'utf8'), before);
});

test('malformed lines are kept as they were while valid rows still close', () => {
  const root = makeRoot();
  writeHandoffs(root, [
    'this is not json',
    handoff('h1', 'navigator', 'executor', 'open'),
    '{"broken": ',
    'null',
  ]);

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 1);

  const lines = readLines(root);
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0], 'this is not json');
  assert.strictEqual(JSON.parse(lines[1]).status, 'closed');
  assert.strictEqual(lines[2], '{"broken": ');
  assert.strictEqual(lines[3], 'null');
});

test('returns 0 and writes nothing when the receiver is empty or missing', () => {
  const root = makeRoot();
  writeHandoffs(root, [handoff('h1', 'navigator', 'executor', 'open')]);
  const before = fs.readFileSync(handoffsPath(root), 'utf8');

  assert.strictEqual(closeMemberHandoffsForReceiver('', root), 0);
  assert.strictEqual(closeMemberHandoffsForReceiver('   ', root), 0);
  assert.strictEqual(closeMemberHandoffsForReceiver(undefined, root), 0);
  assert.strictEqual(closeMemberHandoffsForReceiver(null, root), 0);
  assert.strictEqual(fs.readFileSync(handoffsPath(root), 'utf8'), before);
});

test('returns 0 and creates nothing when there is no handoffs file', () => {
  const root = makeRoot();

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 0);
  assert.strictEqual(fs.existsSync(path.join(root, '.atris')), false);
});

test('returns 0 and leaves the file byte for byte the same when nothing matches', () => {
  const root = makeRoot();
  writeHandoffs(root, [
    handoff('h1', 'navigator', 'executor', 'open'),
    'not json either',
  ]);
  const before = fs.readFileSync(handoffsPath(root), 'utf8');

  assert.strictEqual(closeMemberHandoffsForReceiver('validator', root), 0);
  assert.strictEqual(fs.readFileSync(handoffsPath(root), 'utf8'), before);
});

test('a second call finds nothing left to close', () => {
  const root = makeRoot();
  writeHandoffs(root, [
    handoff('h1', 'navigator', 'executor', 'open'),
    handoff('h2', 'architect', 'executor', 'open'),
  ]);

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 2);
  const afterFirst = fs.readFileSync(handoffsPath(root), 'utf8');
  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 0);
  assert.strictEqual(fs.readFileSync(handoffsPath(root), 'utf8'), afterFirst);
});

test('leaves no lock or temp file behind after closing rows', () => {
  const root = makeRoot();
  writeHandoffs(root, [handoff('h1', 'navigator', 'executor', 'open')]);

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 1);
  assert.deepStrictEqual(fs.readdirSync(stateDir(root)), ['member-handoffs.jsonl']);
});

test('an unreadable handoffs file returns 0 instead of throwing', () => {
  const root = makeRoot();
  // A directory where the file should be makes the read fail.
  fs.mkdirSync(handoffsPath(root), { recursive: true });

  assert.strictEqual(closeMemberHandoffsForReceiver('executor', root), 0);
});
