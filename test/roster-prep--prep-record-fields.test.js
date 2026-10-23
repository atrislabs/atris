'use strict';

// prepRecordFields turns the prep pass result into the fields a heavy
// worker's own run line carries. A prep that landed says who prepped and how
// big the brief is. A prep that was skipped says why, and adds nothing else.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-prep-record-home-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { capBrief, prepRecordFields } = require('../lib/roster-prep');

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test('no prep pass means no record fields', () => {
  assert.deepStrictEqual(prepRecordFields(null), {});
  assert.deepStrictEqual(prepRecordFields(undefined), {});
});

test('a skipped prep pass records only the reason it was skipped', () => {
  const skippedPrep = { ok: false, job: 'search', reason: 'stalled at 5 min', brief: '', lines: 0, bytes: 0 };
  assert.deepStrictEqual(prepRecordFields(skippedPrep), { prep: 'prep skipped: stalled at 5 min' });
  assert.equal('brief_lines' in prepRecordFields(skippedPrep), false);
  assert.equal('brief_bytes' in prepRecordFields(skippedPrep), false);
});

test('a landed prep pass records who prepped and the brief size', () => {
  const landed = { ok: true, job: 'search', engine: 'cursor', brief: 'x', lines: 12, bytes: 345, cut: false };
  assert.deepStrictEqual(prepRecordFields(landed), {
    prep: 'prepped by search',
    brief_lines: 12,
    brief_bytes: 345,
  });
});

test('record sizes come straight from capBrief on a real brief', () => {
  const capped = capBrief('- lib/a.js:1 the entry point\n- lib/b.js:9 the check\n');
  const fields = prepRecordFields({
    ok: true,
    job: 'search',
    engine: 'cursor',
    brief: capped.text,
    lines: capped.lines,
    bytes: capped.bytes,
    cut: capped.cut,
  });
  assert.deepStrictEqual(fields, {
    prep: 'prepped by search',
    brief_lines: 2,
    brief_bytes: Buffer.byteLength('- lib/a.js:1 the entry point\n- lib/b.js:9 the check', 'utf8'),
  });
});

test('the input prep object is not changed', () => {
  const landed = { ok: true, job: 'search', engine: 'cursor', brief: 'x', lines: 3, bytes: 9 };
  const before = JSON.stringify(landed);
  prepRecordFields(landed);
  assert.equal(JSON.stringify(landed), before);
});
