'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point HOME at a throwaway dir and drop ATRIS_* overrides before the module
// loads, so nothing in the require chain reads this machine's settings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-protected-lane-'));
process.env.HOME = sandbox;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { protectedLaneOf } = require('../lib/auto-accept-certified');

test.after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
});

test('a denied tag names its lane, ignoring case and plural endings', () => {
  assert.strictEqual(protectedLaneOf({ tag: 'billing' }), 'billing');
  assert.strictEqual(protectedLaneOf({ tag: 'Deploys' }), 'deploy');
  assert.strictEqual(protectedLaneOf({ tag: 'infra-deploy' }), 'deploy');
  assert.strictEqual(protectedLaneOf({ tag: 'endgame' }), null);
});

test('a denied tag wins over a declared lane, and a tagged row skips text sniffing', () => {
  assert.strictEqual(protectedLaneOf({ tag: 'money', title: 'PROTECTED LANE' }), 'money');
  assert.strictEqual(
    protectedLaneOf({ tag: 'endgame', title: 'PROTECTED LANE: auth/session minting' }),
    'declared',
  );
  assert.strictEqual(
    protectedLaneOf({ tag: 'endgame', metadata: { protected_lane_note: 'Human must accept before landing.' } }),
    'declared',
  );
  // The author classified this row, so the Stripe words in the title do not count.
  assert.strictEqual(protectedLaneOf({ tag: 'endgame', title: 'Stripe checkout' }), null);
});

test('an untagged row falls back to lane terms in its title or objective', () => {
  assert.strictEqual(protectedLaneOf({ title: 'Wire Stripe invoices' }), 'billing');
  assert.strictEqual(protectedLaneOf({ title: 'Rotate the API key' }), 'security');
  assert.strictEqual(
    protectedLaneOf({ title: 'Q3 notes', metadata: { objective: 'Send email to every trial user' } }),
    'customer',
  );
  // A whitespace-only tag counts as no tag at all.
  assert.strictEqual(protectedLaneOf({ tag: '   ', title: 'Stripe checkout' }), 'billing');
});

test('ordinary work and empty or non-object input return null', () => {
  assert.strictEqual(protectedLaneOf(null), null);
  assert.strictEqual(protectedLaneOf(undefined), null);
  assert.strictEqual(protectedLaneOf('billing'), null);
  assert.strictEqual(protectedLaneOf(42), null);
  assert.strictEqual(protectedLaneOf({}), null);
  assert.strictEqual(protectedLaneOf({ title: '   ', objective: '   ' }), null);
  assert.strictEqual(protectedLaneOf({ title: 'Fix typo in README', objective: 'Rename a variable', metadata: null }), null);
  // Matching is narrow on purpose: the bare word "security" is not a lane term.
  assert.strictEqual(protectedLaneOf({ title: 'Improve security docs' }), null);
});
