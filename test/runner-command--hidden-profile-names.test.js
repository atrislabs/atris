'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-hidden-profiles-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { HIDDEN_PROFILE_NAMES } = require('../lib/runner-command');

test('the private commandcode profile is the hidden name', () => {
  assert.ok(Array.isArray(HIDDEN_PROFILE_NAMES));
  assert.equal(Object.isFrozen(HIDDEN_PROFILE_NAMES), true);
  assert.deepEqual([...HIDDEN_PROFILE_NAMES], ['commandcode']);
  assert.equal(HIDDEN_PROFILE_NAMES.includes('commandcode'), true);
  assert.equal(HIDDEN_PROFILE_NAMES.indexOf('commandcode'), 0);
});

test('visible profiles, aliases, and odd spellings stay off the hidden list', () => {
  const visible = [
    'atris-fast',
    'claude',
    'codex',
    'cursor',
    'fable',
    'grok',
    'agy',
    'antigravity',
    'atris2-fast',
    'atris-2-fast',
    'Commandcode',
    'COMMANDCODE',
    ' commandcode',
    'commandcode ',
  ];
  for (const name of visible) {
    assert.equal(HIDDEN_PROFILE_NAMES.includes(name), false);
  }
  assert.equal(HIDDEN_PROFILE_NAMES.length, 1);
});

test('an empty or missing name is not hidden, and the list cannot be called or extended', () => {
  assert.equal(HIDDEN_PROFILE_NAMES.includes(''), false);
  assert.equal(HIDDEN_PROFILE_NAMES.includes(undefined), false);
  assert.equal(HIDDEN_PROFILE_NAMES.includes(null), false);
  assert.equal(HIDDEN_PROFILE_NAMES.indexOf('not-a-profile'), -1);
  assert.throws(() => {
    HIDDEN_PROFILE_NAMES();
  }, TypeError);
  assert.throws(() => {
    HIDDEN_PROFILE_NAMES.push('claude');
  }, TypeError);
  assert.deepEqual([...HIDDEN_PROFILE_NAMES], ['commandcode']);
});
