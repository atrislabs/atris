'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the run off this machine: a throwaway HOME, and no ATRIS_* env the module might read on load.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'business-target-no-business-'));
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { NO_BUSINESS, businessOrSay } = require('../lib/business-target');

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

// Collects what businessOrSay would print to stderr.
function capture() {
  const lines = [];
  return { lines, err: (message) => lines.push(message) };
}

test('NO_BUSINESS is the one-line message that names both fixes', () => {
  assert.strictEqual(NO_BUSINESS, 'no business here. run this inside a business folder, or add --business <slug>');
  assert.strictEqual(NO_BUSINESS.includes('\n'), false);
  assert.ok(NO_BUSINESS.includes('--business <slug>'));
});

test('businessOrSay prints NO_BUSINESS and returns null when no business is found', () => {
  const out = capture();
  const business = businessOrSay({}, { cwd: sandbox, findBusiness: () => null }, out.err);

  assert.strictEqual(business, null);
  assert.deepStrictEqual(out.lines, [NO_BUSINESS]);
});

test('businessOrSay returns the business found in the folder and prints nothing', () => {
  const out = capture();
  const found = { businessId: 'biz_fixture_1', name: 'Fixture Co' };
  const business = businessOrSay({}, { cwd: sandbox, findBusiness: () => found }, out.err);

  assert.deepStrictEqual(business, { id: 'biz_fixture_1', name: 'Fixture Co' });
  assert.deepStrictEqual(out.lines, []);
});

test('businessOrSay treats a folder match without a businessId as no business', () => {
  const out = capture();
  const business = businessOrSay({}, { cwd: sandbox, findBusiness: () => ({ name: 'Orphan' }) }, out.err);

  assert.strictEqual(business, null);
  assert.deepStrictEqual(out.lines, [NO_BUSINESS]);
});

test('an empty --business value reports its own error, not NO_BUSINESS', () => {
  const out = capture();
  const business = businessOrSay({ business: '' }, { cwd: sandbox, findBusiness: () => null }, out.err);

  assert.strictEqual(business, null);
  assert.deepStrictEqual(out.lines, ['--business needs a business slug or id']);
  assert.notStrictEqual(out.lines[0], NO_BUSINESS);
});

test('--business given on the command line wins without looking at the folder', () => {
  const out = capture();
  const business = businessOrSay(
    { business: 'acme' },
    { cwd: sandbox, findBusiness: () => { throw new Error('folder lookup should not run'); } },
    out.err,
  );

  assert.deepStrictEqual(business, { id: 'acme', name: 'acme' });
  assert.deepStrictEqual(out.lines, []);
});
