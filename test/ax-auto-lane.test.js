const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LONG_INPUT_MIN_CHARS,
  SHORT_LOOKUP_MAX_CHARS,
  loadOverrides,
  pickLane,
} = require('../lib/ax-auto-lane');

test('pickLane applies the first matching override before built-in rules', () => {
  const overrides = [
    {
      id: 'learned-first',
      test: { startsWith: 'what is', includesAll: ['capital'], maxChars: 80 },
      lane: 'max',
      reason: 'learned from 4 misses',
    },
    {
      id: 'learned-second',
      test: { startsWith: 'what is' },
      lane: 'pro',
      reason: 'learned from 3 misses',
    },
  ];
  assert.deepEqual(pickLane('What is the capital of France?', { overrides }), {
    lane: 'max',
    reason: 'learned from 4 misses',
    override_id: 'learned-first',
  });
});

test('loadOverrides tolerates missing and corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-overrides-'));
  try {
    const missing = path.join(dir, 'missing.json');
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json', 'utf8');
    assert.deepEqual(loadOverrides(missing), []);
    assert.deepEqual(loadOverrides(corrupt), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto pick traces join completed and rephrased outcomes by pick id', async () => {
  const ax = require('../ax');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-auto-traces-'));
  try {
    const pickLogPath = path.join(dir, 'picks.jsonl');
    const first = ax.appendAutoPick('what is alpha', pickLane('what is alpha'), { pickLogPath, print: true });
    ax.appendAutoOutcome(first, {
      ok: false,
      model: 'atris:fast',
      durationMs: 11,
      error: 'miss',
    });
    const second = ax.appendAutoPick('what is beta', pickLane('what is beta'), { pickLogPath, print: true });
    const payload = await ax.runHeadlessTurn('what is beta', {
      mode: second.lane,
      autoPick: second,
      turnFunction: async () => ({ output: 'beta', durationMs: 12 }),
    });
    assert.equal(payload.ok, true);
    const rows = fs.readFileSync(pickLogPath, 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(rows[0].pick_id, first.pick_id);
    assert.equal(rows[0].message, 'what is alpha');
    assert.ok(rows[0].pick_id);
    assert.ok(rows.some((row) => row.pick_id === first.pick_id && row.outcome === 'rephrased'));
    assert.ok(rows.some((row) => row.pick_id === second.pick_id && row.ok === true && row.duration_ms === 12));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickLane sends short factual lookups to fast', () => {
  assert.equal(pickLane('what is the capital of france?').lane, 'fast');
  assert.equal(pickLane('please list the primary colors').lane, 'fast');
});

test('pickLane includes the short lookup boundary in fast', () => {
  const message = `define ${'x'.repeat(SHORT_LOOKUP_MAX_CHARS - 7)}`;
  assert.equal(message.length, SHORT_LOOKUP_MAX_CHARS);
  assert.equal(pickLane(message).lane, 'fast');
});

test('pickLane sends a lookup beyond the short boundary to pro', () => {
  const message = `define ${'x'.repeat(SHORT_LOOKUP_MAX_CHARS - 6)}`;
  assert.equal(message.length, SHORT_LOOKUP_MAX_CHARS + 1);
  assert.equal(pickLane(message).lane, 'pro');
});

test('pickLane sends heavy reasoning requests to max', () => {
  assert.equal(pickLane('compare the tradeoffs of queues and event streams').lane, 'max');
  assert.equal(pickLane('planning an offline-first sync architecture').lane, 'max');
});

test('pickLane sends multiple questions to max', () => {
  assert.equal(pickLane('what shipped? who owns the follow-up?').lane, 'max');
});

test('pickLane sends input over the long boundary to max', () => {
  const message = 'x'.repeat(LONG_INPUT_MIN_CHARS + 1);
  assert.equal(pickLane(message).lane, 'max');
});

test('pickLane leaves the exact long boundary in pro', () => {
  const message = 'x'.repeat(LONG_INPUT_MIN_CHARS);
  assert.equal(pickLane(message).lane, 'pro');
});

test('pickLane sends fenced bounded fixes to code-fast', () => {
  const message = 'fix this function:\n```js\nreturn value + 1;\n```';
  assert.equal(pickLane(message).lane, 'code-fast');
});

test('pickLane sends stack trace debugging to code-fast', () => {
  const message = 'debugging this trace:\nTypeError: value is not a function\n    at run (/tmp/app.js:4:2)';
  assert.equal(pickLane(message).lane, 'code-fast');
});

test('pickLane requires an edit verb with code context', () => {
  const message = 'explain this:\n```js\nreturn value + 1;\n```';
  assert.equal(pickLane(message).lane, 'pro');
});

test('pickLane defaults general requests to pro', () => {
  assert.equal(pickLane('write a friendly project update').lane, 'pro');
  assert.deepEqual(pickLane(''), { lane: 'pro', reason: 'pro fits this general request.' });
});

test('pickLane reasons are lowercase sentences', () => {
  for (const message of [
    'what time is it?',
    'analyze this proposal',
    'fix this:\n```js\nthrow new Error();\n```',
    'draft a reply',
  ]) {
    const { reason } = pickLane(message);
    assert.equal(reason, reason.toLowerCase());
    assert.match(reason, /^[a-z][^.]*\.$/);
  }
});

test('pickLane holds a 95 percent floor on the labeled dev set', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const gold = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'det', 'data', 'ax-lane-gold.jsonl'), 'utf8')
    .split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const correct = gold.filter((row) => pickLane(row.message).lane === row.lane).length;
  assert.ok(correct / gold.length >= 0.95, `dev set accuracy ${correct}/${gold.length} fell below the floor`);
});
