const test = require('node:test');
const assert = require('node:assert');
const { missionProtectedLaneHold } = require('../commands/mission');

test('a mission in a denied lane is held before any tick fires', () => {
  const hold = missionProtectedLaneHold({ lane: 'billing', objective: 'rotate invoices' });
  assert.ok(hold);
  assert.strictEqual(hold.pause_reason, 'protected-lane-billing');
});

test('protected-lane text in the objective holds the mission even in a safe lane', () => {
  const hold = missionProtectedLaneHold({ lane: 'workspace', objective: 'mint a scoped payment authorization and settle the checkout url flow' });
  assert.ok(hold, 'sniffed billing terms hold the tick');
});

test('an ordinary workspace mission is not held', () => {
  assert.strictEqual(missionProtectedLaneHold({ lane: 'workspace', objective: 'clean stale wiki pages and pin a check' }), null);
});

test('an explicit human ack releases the hold', () => {
  const hold = missionProtectedLaneHold({ lane: 'billing', objective: 'rotate invoices', metadata: { protected_lane_ack: 'keshav 2026-07-26' } });
  assert.strictEqual(hold, null);
});
