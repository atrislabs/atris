'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-say-wish-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  delete process.env.USER;
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { sayWish } = require('../commands/wish');
  const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
  function seed() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      id: 'wish-fixed-example', n: 1, text: 'Build a garden',
      ts: '2024-01-02T12:00:00.000Z', status: 'captured',
    }) + '\n');
  }
  return { root, file, seed, logs, errors, sayWish };
}

test('sayWish appends a steering note for a trailing wish reference', (t) => {
  const f = fixture(t);
  f.seed();
  assert.strictEqual(f.sayWish(['say', 'Plant', 'more trees', 'wish-fixed-example'], f.root), 0);
  const rows = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(rows.length, 2);
  // The generated timestamp is incidental; no assertion depends on the clock.
  const { ts, ...note } = rows[1];
  assert.deepStrictEqual(note, {
    kind: 'steer', wish_id: 'wish-fixed-example', note: 'Plant more trees',
    steered_by: 'operator', mission_id: null,
  });
  assert.deepStrictEqual(f.logs, ['Steering captured for "Build a garden".']);
  assert.deepStrictEqual(f.errors, []);
});

test('sayWish accepts a leading numeric reference and ignores blank arguments', (t) => {
  const f = fixture(t);
  f.seed();
  assert.strictEqual(f.sayWish(['say', ' ', '1', '  Keep the pond  ', '\t'], f.root), 0);
  const rows = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].wish_id, 'wish-fixed-example');
  assert.strictEqual(rows[1].note, 'Keep the pond');
  assert.deepStrictEqual(f.errors, []);
});

test('sayWish rejects empty notes without creating storage', (t) => {
  const f = fixture(t);
  assert.strictEqual(f.sayWish(['say', ' ', '\t'], f.root), 2);
  assert.deepStrictEqual(f.errors, ['wish say needs a note.']);
  assert.deepStrictEqual(f.logs, []);
  assert.strictEqual(fs.existsSync(f.file), false);
});

test('sayWish reports an unknown explicit wish without appending a note', (t) => {
  const f = fixture(t);
  f.seed();
  const before = fs.readFileSync(f.file, 'utf8');
  assert.strictEqual(f.sayWish(['say', 'Add a bench', 'wish-missing'], f.root), 2);
  assert.deepStrictEqual(f.errors, ['No wish found with id wish-missing.']);
  assert.deepStrictEqual(f.logs, []);
  assert.strictEqual(fs.readFileSync(f.file, 'utf8'), before);
});
