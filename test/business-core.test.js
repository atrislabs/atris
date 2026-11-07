'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const businessCore = require('../lib/business-core');
const businessCommandModule = require('../commands/business');

test('lib/business-core exports shared helpers re-exported by commands/business', () => {
  const sharedKeys = [
    'businessWorkspaceBase',
    'loadBusinesses',
    'saveBusinesses',
    'businessMatchesSlug',
    'isAccidentalHelpBusiness',
    'validateBusinessCreateName',
    'parseBusinessShipArgs',
    'shipTeamNames',
    'shipTaskTitle',
    'analyzeBusinessDoctor',
    'createCanonicalBusinessWorkspace',
    'onboardBusiness',
    'shareBusinessWorkspace',
    'collectBusinessShareState',
    'renderBusinessCreatedNextSteps',
    'recordBusinessRun',
    'normalizeOrdersPayload',
    'parseBusinessStoreArgs',
    'readStorefront',
    'readWalletNet',
  ];

  for (const key of sharedKeys) {
    assert.equal(typeof businessCore[key], 'function', `expected ${key} in lib/business-core`);
    assert.equal(businessCommandModule[key], businessCore[key], `expected commands/business to re-export ${key}`);
  }
});

test('lib/business-core parses ship args, store args, outcomes, and order payloads', () => {
  const ship = businessCore.parseBusinessShipArgs(['Build', 'an', 'agency', '--name', 'Acme Lab', '--email=ops@acme.test', '--yes']);
  assert.equal(ship.ok, true);
  assert.equal(ship.description, 'Build an agency');
  assert.equal(ship.name, 'Acme Lab');
  assert.equal(ship.email, 'ops@acme.test');

  assert.deepEqual(businessCore.parseBusinessStoreArgs(['on', 'acme']), { action: 'on', slug: 'acme' });
  assert.deepEqual(businessCore.parseBusinessStoreArgs(['acme', 'status']), { action: 'status', slug: 'acme' });

  assert.equal(businessCore.normalizeOutcome('win'), 'positive');
  assert.equal(businessCore.normalizeOutcome('regressed'), 'negative');
  assert.equal(businessCore.normalizeOutcome('partial'), 'mixed');
  assert.equal(businessCore.defaultRewardForOutcome('positive'), 5);

  const normalized = businessCore.normalizeOrdersPayload({
    summary: { revenue_cents: 2500, paid_orders: 1, pending_revenue_cents: 500 },
    orders: [
      { id: 'ord-1', product_name: 'Starter Pack', quantity: 2, buyer_name: 'Ada', status: 'paid', amount_cents: 2500, created_at: '2026-04-20T00:00:00Z' },
    ],
  });
  assert.equal(normalized.revenueCents, 2500);
  assert.equal(normalized.paidOrders, 1);
  assert.equal(normalized.orders.length, 1);
  assert.equal(normalized.orders[0].product, 'Starter Pack');
  assert.equal(normalized.orders[0].quantity, 2);
});
