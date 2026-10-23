'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { wantsJson, compactErrorPayload, compactSuccessPayload, printCliJson } = require('../lib/cli-json');

test('wantsJson only fires on an exact --json token in an array', () => {
  assert.equal(wantsJson(['x', '--json']), true);
  assert.equal(wantsJson(['--json=1']), false);
  assert.equal(wantsJson('--json'), false);
  assert.equal(wantsJson(), false);
});

test('compactErrorPayload fills defaults and stringifies fields', () => {
  assert.deepEqual(compactErrorPayload(), {
    ok: false, reason: 'error', detail: null, selected_ref: null, next_command: null,
  });
  assert.deepEqual(compactErrorPayload({ reason: '', detail: 404, selected_ref: 7, next_command: 'atris x' }), {
    ok: false, reason: 'error', detail: '404', selected_ref: '7', next_command: 'atris x',
  });
});

test('compactSuccessPayload drops empty ids and keeps real ones', () => {
  assert.deepEqual(compactSuccessPayload({ action: 'claimed', ids: { task: 'T1', run: null, lane: '', n: 0 } }), {
    ok: true, action: 'claimed', task: 'T1', n: 0,
  });
  assert.deepEqual(compactSuccessPayload(), { ok: true, action: 'ok' });
  assert.deepEqual(compactSuccessPayload({ action: 'a', ids: null, next_command: 'atris next' }), {
    ok: true, action: 'a', next_command: 'atris next',
  });
});

test('printCliJson prints the compact body by default and the full one on --full or --verbose', () => {
  const printed = [];
  const print = (text) => printed.push(text);
  const full = { ok: true, everything: [1, 2, 3] };
  const compact = { ok: true };
  assert.equal(printCliJson(full, compact, ['--json'], print), compact);
  assert.equal(printCliJson(full, compact, ['--json', '--full'], print), full);
  assert.equal(printCliJson(full, compact, ['--verbose'], print), full);
  assert.deepEqual(printed.map((t) => JSON.parse(t)), [compact, full, full]);
  assert.equal(printed[0], '{\n  "ok": true\n}');
});
