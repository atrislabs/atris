'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeBusinessDoctor } = require('../commands/business');

test('doctor repairs a cached alias pointing to another active business', () => {
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [
      { id: 'biz-current', slug: 'current-shop', aliases: ['old-shop'] },
      { id: 'biz-other', slug: 'other-shop' },
    ],
    cache: {
      'current-shop': { business_id: 'biz-current', slug: 'current-shop' },
      'other-shop': { business_id: 'biz-other', slug: 'other-shop' },
      'old-shop': { business_id: 'biz-other', slug: 'old-shop' },
    },
  });

  assert.strictEqual(analysis.issues.some(issue =>
    issue.code === 'missing-alias-cache' && issue.subject === 'old-shop'), true);
  assert.strictEqual(analysis.cacheUpdates['old-shop']?.business_id, 'biz-current');
});
