'use strict';

// rosterToolLabel turns an engine id into the name a roster line shows a person.
// Two engines have a friendlier spelling ("claude" reads as "claude code",
// "atris-fast" reads as "atris fast"). Every other id is shown as it is, and
// nothing empty is turned into something else. These tests pin that mapping.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the module off this machine: any state or env reads go to a throwaway HOME.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-registry-tool-label-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const { rosterToolLabel } = require('../lib/engine-registry');

test('gives the two engines with friendlier roster names their spaced labels', () => {
  assert.strictEqual(rosterToolLabel('claude'), 'claude code');
  assert.strictEqual(rosterToolLabel('atris-fast'), 'atris fast');
});

test('shows every other engine id unchanged, and passes empty input straight back', () => {
  for (const id of ['codex', 'agy', 'devin', 'grok', 'cursor']) {
    assert.strictEqual(rosterToolLabel(id), id);
  }
  assert.strictEqual(rosterToolLabel(''), '');
  assert.strictEqual(rosterToolLabel(undefined), undefined);
});
