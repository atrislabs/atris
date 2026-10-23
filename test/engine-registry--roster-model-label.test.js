'use strict';

// rosterModelLabel turns a saved model id into the short words a person reads
// on a roster line ("claude-opus-5-5" -> "opus 5.5"). It is pure string work,
// so the only setup is an empty HOME and no ATRIS_* variables, in case the
// module reads them at load time. Nothing here reads the clock or the disk.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-registry-label-'));
process.env.HOME = sandboxHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { rosterModelLabel } = require('../lib/engine-registry');

test('reads a claude model id as family and version', () => {
  assert.strictEqual(rosterModelLabel('claude-opus-5-5'), 'opus 5.5');
  assert.strictEqual(rosterModelLabel('claude-sonnet-5-5'), 'sonnet 5.5');
  assert.strictEqual(rosterModelLabel('claude-haiku-5-5'), 'haiku 5.5');
  assert.strictEqual(rosterModelLabel('claude-fable-5-1'), 'fable 5.1');
  assert.strictEqual(rosterModelLabel('claude-opus-5'), 'opus 5');
});

test('drops the 8-digit release date and keeps the version', () => {
  assert.strictEqual(rosterModelLabel('claude-opus-5-5-20260101'), 'opus 5.5');
  assert.strictEqual(rosterModelLabel('claude-haiku-5-5-20251001'), 'haiku 5.5');
});

test('reads grok ids, with the build-fast variant named fast', () => {
  assert.strictEqual(rosterModelLabel('grok-4.2-build-fast'), 'grok 4.2 fast');
  assert.strictEqual(rosterModelLabel('grok-5'), 'grok 5');
});

test('returns any other model name as written, trimmed', () => {
  assert.strictEqual(rosterModelLabel('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.strictEqual(rosterModelLabel('  gpt-5.6-sol  '), 'gpt-5.6-sol');
  // A date that is not exactly 8 digits does not match the claude pattern,
  // so the whole id is kept as written.
  assert.strictEqual(rosterModelLabel('claude-opus-5-5-2026'), 'claude-opus-5-5-2026');
});

test('gives an empty label for a missing or blank model', () => {
  assert.strictEqual(rosterModelLabel(''), '');
  assert.strictEqual(rosterModelLabel('   '), '');
  assert.strictEqual(rosterModelLabel(null), '');
  assert.strictEqual(rosterModelLabel(undefined), '');
});
