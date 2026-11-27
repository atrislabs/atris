'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-free-builders-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const { buildEngineCommand, DISPATCH_CAPABLE } = require('../lib/fleet');
const { resolveRosterWords } = require('../lib/engine-registry');

test('a devin dispatch pins the free model and opens write permission', () => {
  const command = buildEngineCommand('devin', '/tmp/prompt.md');
  assert.match(command, /--permission-mode dangerous/);
  assert.match(command, /--model swe-2-1-high/);
});

test('a paid devin router or lightning model is refused before launch', () => {
  assert.throws(
    () => buildEngineCommand('devin', '/tmp/prompt.md', { model: 'swe-2-lightning' }),
    /paid.*swe-2-1-high/,
  );
  assert.throws(
    () => buildEngineCommand('devin', '/tmp/prompt.md', { model: 'adaptive' }),
    /paid.*swe-2-1-high/,
  );
});

test('a droid dispatch runs exec with high write permission and its free default model', () => {
  const command = buildEngineCommand('droid', '/tmp/prompt.md');
  assert.match(command, /^droid exec /);
  assert.match(command, /--auto high/);
  assert.match(command, /--model glm-5\.3/);
});

test('a sealed droid dispatch lowers write permission to medium', () => {
  assert.match(buildEngineCommand('droid', '/tmp/prompt.md', { sealed: true }), /--auto medium/);
});

test('droid is dispatchable and resolves through the roster lookup', () => {
  assert.ok(DISPATCH_CAPABLE.includes('droid'));
  assert.deepEqual(resolveRosterWords('droid glm-5.3'), { engine: 'droid', model: 'glm-5.3', effort: '' });
});
