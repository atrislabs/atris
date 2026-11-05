'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const packCore = require('../lib/pack-core');
const packCommand = require('../commands/pack');

test('pack-core exports shared packet, manifest, secret-scan, registry, share, browse, and sales helpers', () => {
  assert.equal(typeof packCore.slugify, 'function');
  assert.equal(typeof packCore.buildManifest, 'function');
  assert.equal(typeof packCore.classifyPacketPath, 'function');
  assert.equal(typeof packCore.collectPacketEntries, 'function');
  assert.equal(typeof packCore.buildContentHashes, 'function');
  assert.equal(typeof packCore.verifyArchiveContentHashes, 'function');
  assert.equal(typeof packCore.scanTextForSecrets, 'function');
  assert.equal(typeof packCore.redactSecret, 'function');
  assert.equal(typeof packCore.registryUrl, 'function');
  assert.equal(typeof packCore.parsePackShareArgs, 'function');
  assert.equal(typeof packCore.formatPackBrowseTable, 'function');
  assert.equal(typeof packCore.formatPackSalesTable, 'function');
  assert.equal(typeof packCore.formatPackPurchasesTable, 'function');
  assert.equal(typeof packCore.formatSalesDollars, 'function');
  assert.equal(typeof packCore.PACKET, 'object');
  assert.equal(typeof packCore.REGISTRY_LIMITS, 'object');
  assert.equal(typeof packCore.PACK_VISIBILITIES, 'object');
});

test('commands/pack re-exports shared pack-core helpers with identical references', () => {
  const sharedKeys = [
    'sanitizePersonalizationName',
    'parsePackShareArgs',
    'formatShareExpiry',
    'formatPackShareLinksTable',
    'formatPackBrowseTable',
    'packSalesUrl',
    'formatSalesDollars',
    'formatPackSalesTable',
    'formatPackPurchasesTable',
    'buildManifest',
    'comparePackVersions',
    'classifyPacketPath',
    'collectPacketEntries',
    'scanTextForSecrets',
    'redactSecret',
    'registryLimitFailures',
    'REGISTRY_LIMITS',
  ];

  for (const key of sharedKeys) {
    assert.equal(packCommand[key], packCore[key], `Expected commands/pack.${key} to match lib/pack-core.${key}`);
  }
});

test('pack-core version, slug, and manifest helpers behave deterministically', () => {
  assert.equal(packCore.slugify('  My Research Pack!!  '), 'my-research-pack');
  assert.equal(packCore.titleFromSlug('my-research-pack'), 'My Research Pack');
  assert.deepEqual(packCore.parseSemver('1.2.3'), [1, 2, 3]);
  assert.equal(packCore.parseSemver('v1.2.3'), null);
  assert.equal(packCore.bumpVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(packCore.bumpVersion('0.1.0', 'minor'), '0.2.0');
  assert.equal(packCore.bumpVersion('0.1.0', 'major'), '1.0.0');
  assert.equal(packCore.comparePackVersions('0.2.0', '0.1.9'), 1);
  assert.equal(packCore.comparePackVersions('0.1.0', '0.1.0'), 0);

  const manifest = packCore.buildManifest(null, {
    slug: 'demo-pack',
    author: 'Ada',
    notes: 'initial release',
    visibility: 'public',
  });
  assert.equal(manifest.slug, 'demo-pack');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.visibility, 'public');
  assert.equal(manifest.author, 'Ada');
});

test('pack-core browse and sales formatting helpers format rows cleanly', () => {
  assert.equal(packCore.formatSalesDollars(0), '$0');
  assert.equal(packCore.formatSalesDollars(2500), '$25');
  assert.equal(packCore.formatSalesDollars(1999), '$19.99');

  const browseTable = packCore.formatPackBrowseTable({
    packs: [
      {
        slug: 'ocean-pack',
        title: 'Ocean Pack',
        version: '0.1.0',
        priceCents: 1500,
        stars: 4,
      },
    ],
  });
  assert.match(browseTable, /ocean-pack/);
  assert.match(browseTable, /\$15/);

  const salesTable = packCore.formatPackSalesTable([
    {
      slug: 'ocean-pack',
      buyer: 'b***@example.com',
      price_cents: 1500,
      granted_at: '2026-04-01T12:00:00.000Z',
      refunded: false,
    },
  ]);
  assert.match(salesTable, /ocean-pack/);
  assert.match(salesTable, /b\*\*\*@example\.com/);
  assert.match(salesTable, /\$15/);
});
