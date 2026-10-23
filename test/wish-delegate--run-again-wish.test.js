'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-again-'));
  const cwd = process.cwd();
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  process.env.PATH = root;
  process.chdir(root);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-06T12:00:00.000Z') });
  const logs = [];
  const errors = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.after(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { runAgainWish } = require('../lib/wish-delegate');
  const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
  return {
    root, file, logs, errors, runAgainWish,
    seed(record) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(record) + '\n');
    },
  };
}

test('runAgainWish captures a follow-up linked to its parent without starting an engine', (t) => {
  const f = fixture(t);
  f.seed({ id: 'wish-parent', n: 7, text: 'make help clearer', status: 'captured', ts: '2026-07-01T12:00:00.000Z' });
  const result = f.runAgainWish(['again', 'wish-parent', 'make', 'help clearer for operators'], f.root,
    { noMission: true, asJson: true, singleTask: true });
  assert.strictEqual(result, 1);
  const records = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
  const child = records[1];
  assert.strictEqual(child.parent_id, 'wish-parent');
  assert.strictEqual(child.text, 'make help clearer for operators');
  assert.strictEqual(child.n, 8);
  assert.strictEqual(child.ts, '2026-07-06T12:00:00.000Z');
  assert.notStrictEqual(child.id, 'wish-parent');
  const output = JSON.parse(f.logs.join('\n'));
  assert.strictEqual(output.wish_id, child.id);
  assert.strictEqual(output.status, 'needs_input');
  assert.ok(output.questions.includes('Which working builder should handle this?'));
  assert.strictEqual(records.at(-1).status, 'needs_input');
  assert.ok(records.every((record) => !record.mission_id && !record.task_id));
});

test('runAgainWish rejects missing or whitespace-only arguments without writing', (t) => {
  const f = fixture(t);
  for (const args of [['again'], ['again', ' ', 'a tweak'], ['again', 'wish-parent'], ['again', 'wish-parent', ' ', '\t']]) {
    assert.strictEqual(f.runAgainWish(args, f.root), 2);
  }
  assert.deepStrictEqual(f.errors, Array(4).fill('wish again needs a parent id and tweak text.'));
  assert.deepStrictEqual(f.logs, []);
  assert.strictEqual(fs.existsSync(f.file), false);
});

test('runAgainWish reports an unknown parent in an empty store without writing', (t) => {
  const f = fixture(t);
  assert.strictEqual(f.runAgainWish(['again', ' missing-parent ', 'a tweak'], f.root), 2);
  assert.deepStrictEqual(f.errors, ['No wish found with id missing-parent.']);
  assert.deepStrictEqual(f.logs, []);
  assert.strictEqual(fs.existsSync(f.file), false);
});
