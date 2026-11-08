const test = require('node:test');
const assert = require('node:assert/strict');
const xpCore = require('../lib/xp-core');
const xpCommandModule = require('../commands/xp');

test('xp-core exports shared AgentXP ledger, graph, capsule, and sync packet helpers', () => {
  assert.equal(typeof xpCore.buildCareerXpProjection, 'function');
  assert.equal(typeof xpCore.collectLocalXpProjection, 'function');
  assert.equal(typeof xpCore.buildCareerXpSessionCapsule, 'function');
  assert.equal(typeof xpCore.buildAgentXpSyncPacket, 'function');
  assert.equal(typeof xpCore.normalizeReceiptChain, 'function');
  assert.equal(xpCommandModule.buildCareerXpProjection, xpCore.buildCareerXpProjection);
  assert.equal(xpCommandModule.collectLocalXpProjection, xpCore.collectLocalXpProjection);
});

test('xp-core calculates level progression and contribution graph intensity', () => {
  assert.equal(xpCore.levelFromXp(0), 1);
  assert.equal(xpCore.levelFromXp(999), 1);
  assert.equal(xpCore.levelFromXp(1000), 2);
  assert.equal(xpCore.graphIntensity(0, 100), 0);
  assert.equal(xpCore.graphIntensity(10, 100), 1);
  assert.equal(xpCore.graphIntensity(30, 100), 2);
  assert.equal(xpCore.graphIntensity(60, 100), 3);
  assert.equal(xpCore.graphIntensity(80, 100), 4);
});

test('xp-core verifies receipt hash chains and detects duplicate identical receipts', () => {
  const first = xpCore.withReceiptIntegrity({
    receipt_id: 'task_review:ep1',
    outcome: 'accepted',
    xp: 50,
    title: 'First receipt',
  }, null);
  const chain = xpCore.normalizeReceiptChain([first, { ...first }]);
  assert.equal(chain.integrity.status, 'verified');
  assert.equal(chain.receipts.length, 1);
  assert.equal(chain.deduped, true);
});
