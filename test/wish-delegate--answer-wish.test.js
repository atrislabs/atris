'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t, records = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-wish-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = root;
  // No installed command or engine can be discovered or launched.
  process.env.PATH = path.join(root, 'empty-bin');
  const errors = [];
  const previousError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => {
    console.error = previousError;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, '.atris', 'state', 'wishes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(record => JSON.stringify(record) + '\n').join(''));
  return { root, file, errors, answerWish: require('../lib/wish-delegate').answerWish };
}

const waiting = (n) => ({
  id: `wish-2024-01-01-test-${n}`,
  n,
  ts: '2024-01-01T12:00:00.000Z',
  text: 'add a save button to the editor',
  status: 'needs_input',
  questions: ['What should the save button do?'],
});

test('answerWish sends an explicit answer to the selected waiting wish', t => {
  const { root, file, answerWish } = fixture(t, [waiting(1), waiting(2)]);
  const calls = [];
  // An explicit reference skips the clock-dependent stale-question path.
  const result = answerWish(['answer', '#1', 'save the editor document', 'to local storage'], root, {
    cloudDispatch(wish, text, dispatchRoot) {
      calls.push({ wish, text, dispatchRoot });
      return 0;
    },
  });
  assert.strictEqual(result, 0);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].wish.id, waiting(1).id);
  assert.deepStrictEqual(calls[0].wish.answers, ['save the editor document to local storage']);
  assert.strictEqual(calls[0].text, 'add a save button to the editor save the editor document to local storage');
  assert.strictEqual(calls[0].dispatchRoot, root);
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[2].id, waiting(1).id);
  assert.strictEqual(events[2].answer, 'save the editor document to local storage');
});

test('answerWish rejects an unknown explicit target without changing stored wishes', t => {
  const { root, file, errors, answerWish } = fixture(t, [waiting(1)]);
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(answerWish(['answer', '#99', 'save locally'], root), 2);
  assert.deepStrictEqual(errors, ['No wish waiting on an answer matches #99.']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('answerWish rejects empty answers and an answer with no waiting wish', t => {
  const { root, file, errors, answerWish } = fixture(t);
  assert.strictEqual(answerWish(['answer', '  ', '\t'], root), 2);
  assert.strictEqual(answerWish(['answer', 'save locally'], root), 2);
  assert.deepStrictEqual(errors, [
    'wish answer needs your answer in plain words.',
    'No wish is waiting on an answer.',
  ]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
});
