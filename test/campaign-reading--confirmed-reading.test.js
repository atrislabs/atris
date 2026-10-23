'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { confirmedReading } = require('../lib/campaign-reading');

test('two passing runs return the fresh result with combined seconds', async () => {
  const first = { passed: true, seconds: 1.25, summary: 'first pass', reading: 0.8 };
  const second = { passed: true, seconds: 2.5, summary: 'fresh pass', reading: 1, output_tail: 'all passed' };
  const results = [first, second];
  let calls = 0;

  const actual = await confirmedReading(async () => results[calls++]);

  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(actual, { ...second, seconds: 3.75 });
  assert.strictEqual(first.seconds, 1.25);
  assert.strictEqual(second.seconds, 2.5);
});

test('an initial failure is returned unchanged without another run', async () => {
  const failure = { passed: false, seconds: 3, summary: 'failed', exit: 1 };
  let calls = 0;

  const actual = await confirmedReading(async () => {
    calls++;
    return failure;
  });

  assert.strictEqual(calls, 1);
  assert.strictEqual(actual, failure);
});

test('a fresh failure uses its summary, last output line, or exit code', async () => {
  const cases = [
    { result: { summary: 'explicit failure', output_tail: 'other output', exit: 1 }, said: 'explicit failure' },
    { result: { summary: '', output_tail: 'earlier line\n  final failure  \n\n', exit: 2 }, said: 'final failure' },
    { result: { output_tail: '\n  \n', exit: 7 }, said: 'exit 7' },
  ];

  for (const { result, said } of cases) {
    const second = { ...result, passed: false, seconds: 2, reading: 0.25 };
    let calls = 0;
    const actual = await confirmedReading(async () => ++calls === 1
      ? { passed: true, seconds: 1 }
      : second);

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(actual, {
      ...second,
      seconds: 3,
      summary: `passed once, then failed a fresh run: ${said}`,
    });
    assert.strictEqual(second.summary, result.summary);
  }
});

test('missing or nonnumeric seconds count as zero and numeric strings are added', async () => {
  for (const [firstSeconds, secondSeconds, expected] of [
    [undefined, undefined, 0],
    ['invalid', 2, 2],
    ['1.5', '2.25', 3.75],
  ]) {
    let calls = 0;
    const actual = await confirmedReading(async () => ({
      passed: true,
      seconds: ++calls === 1 ? firstSeconds : secondSeconds,
    }));

    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(actual, { passed: true, seconds: expected });
  }
});

test('runner errors propagate from either run without extra calls', async () => {
  for (const failingCall of [1, 2]) {
    const error = new Error('judge could not run');
    let calls = 0;

    await assert.rejects(confirmedReading(async () => {
      if (++calls === failingCall) throw error;
      return { passed: true, seconds: 1 };
    }), (actual) => actual === error);

    assert.strictEqual(calls, failingCall);
  }
});
