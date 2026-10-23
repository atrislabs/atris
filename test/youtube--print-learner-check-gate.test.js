const test = require('node:test');
const assert = require('node:assert');
const { printLearnerCheckGate } = require('../commands/youtube');

test('prints the first mechanism check before the initial score', () => {
  const lines = [];
  const result = printLearnerCheckGate((line) => lines.push(line), {
    mechanisms: ['Overton window', 'feedback loop'],
    numbers: ['25%'],
  }, { includeCheck: true });

  assert.deepStrictEqual(lines, ['check: what is the Overton window?', 'score: 0']);
  assert.strictEqual(result, undefined);
});

test('uses the first number when there are no mechanisms', () => {
  const lines = [];
  printLearnerCheckGate((line) => lines.push(line), {
    mechanisms: [],
    numbers: ['25%', '10 seconds'],
  }, { includeCheck: true });

  assert.deepStrictEqual(lines, [
    'check: what does 25% measure in this chapter?',
    'score: 0',
  ]);
});

test('omits the question by default but still prints an inferred score', () => {
  const lines = [];
  printLearnerCheckGate((line) => lines.push(line), { mechanisms: ['feedback loop'] });
  assert.deepStrictEqual(lines, ['score: 0']);
});

test('empty or non-array lesson fields produce a placeholder without a score', () => {
  for (const lesson of [undefined, {}, { mechanisms: [], numbers: [] },
    { mechanisms: 'feedback loop', numbers: '25%' }]) {
    const lines = [];
    printLearnerCheckGate((line) => lines.push(line), lesson, { includeCheck: true });
    assert.deepStrictEqual(lines, ['check: fill this']);

    lines.length = 0;
    printLearnerCheckGate((line) => lines.push(line), lesson);
    assert.deepStrictEqual(lines, []);
  }
});

test('JSON mode and missing output callbacks return without inspecting the lesson', () => {
  const lines = [];
  assert.strictEqual(printLearnerCheckGate((line) => lines.push(line), null, {
    includeCheck: true, json: true,
  }), undefined);
  assert.deepStrictEqual(lines, []);

  for (const output of [undefined, null, false, 'output', {}]) {
    assert.strictEqual(printLearnerCheckGate(output, null, { includeCheck: true }), undefined);
  }
});
