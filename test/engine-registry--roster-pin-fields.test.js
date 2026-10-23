'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-pin-fields-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

const { ROSTER_PIN_FIELDS } = require('../lib/engine-registry');

test('ROSTER_PIN_FIELDS lists the four roster pin attributes in standard order', () => {
  assert.deepStrictEqual(
    [...ROSTER_PIN_FIELDS],
    ['roster_model', 'roster_effort', 'roster_max_seconds', 'roster_prep']
  );
  assert.strictEqual(ROSTER_PIN_FIELDS.length, 4);

  for (const field of ['roster_model', 'roster_effort', 'roster_max_seconds', 'roster_prep']) {
    assert.strictEqual(ROSTER_PIN_FIELDS.includes(field), true);
  }

  assert.strictEqual(new Set(ROSTER_PIN_FIELDS).size, ROSTER_PIN_FIELDS.length);
  for (const field of ROSTER_PIN_FIELDS) {
    assert.strictEqual(typeof field, 'string');
    assert.strictEqual(field.startsWith('roster_'), true);
  }
});

test('ROSTER_PIN_FIELDS extracts pinned attributes from an engine configuration', () => {
  const engine = {
    id: 'codex',
    bin: 'codex',
    roster_model: 'gpt-5-codex',
    roster_effort: 'high',
    roster_max_seconds: 900,
    roster_prep: 'warmup',
    extra_field: 'unrelated',
  };

  const extracted = {};
  for (const field of ROSTER_PIN_FIELDS) {
    if (engine[field]) extracted[field] = engine[field];
  }

  assert.deepStrictEqual(extracted, {
    roster_model: 'gpt-5-codex',
    roster_effort: 'high',
    roster_max_seconds: 900,
    roster_prep: 'warmup',
  });
});

test('ROSTER_PIN_FIELDS is frozen and cannot be mutated or invoked as a function', () => {
  assert.strictEqual(Object.isFrozen(ROSTER_PIN_FIELDS), true);

  assert.throws(() => {
    ROSTER_PIN_FIELDS.push('roster_temperature');
  }, TypeError);

  assert.throws(() => {
    ROSTER_PIN_FIELDS[0] = 'custom_field';
  }, TypeError);

  assert.throws(() => {
    ROSTER_PIN_FIELDS();
  }, TypeError);
});

test('ROSTER_PIN_FIELDS rejects invalid, empty, or unpinned fields', () => {
  assert.strictEqual(ROSTER_PIN_FIELDS.includes(''), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes('   '), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes(null), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes(undefined), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes(0), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes({}), false);

  assert.strictEqual(ROSTER_PIN_FIELDS.includes('ROSTER_MODEL'), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes(' roster_model '), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes('model'), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes('effort'), false);
  assert.strictEqual(ROSTER_PIN_FIELDS.includes('roster_until'), false);

  const emptyEngine = {};
  const emptyExtracted = {};
  for (const field of ROSTER_PIN_FIELDS) {
    if (emptyEngine[field]) emptyExtracted[field] = emptyEngine[field];
  }
  assert.deepStrictEqual(emptyExtracted, {});
});
