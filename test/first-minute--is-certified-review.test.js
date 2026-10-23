'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isCertifiedReview } = require('../lib/first-minute');

test('explicit boolean certification in either source certifies a review', () => {
  assert.strictEqual(isCertifiedReview({ review: { agent_certified: true } }), true);
  assert.strictEqual(isCertifiedReview({ metadata: { agent_certified: true } }), true);
  assert.strictEqual(isCertifiedReview({
    review: { agent_certified: false, agent_review_pass_count: 1 },
    metadata: { agent_certified: true },
  }), true);
  assert.strictEqual(isCertifiedReview({ review: { agent_certified: 'true' } }), false);
  assert.strictEqual(isCertifiedReview({ metadata: { agent_certified: 1 } }), false);
});

test('two review passes are sufficient, including numeric strings and metadata', () => {
  for (const source of ['review', 'metadata']) {
    for (const count of [0, 1, -1]) {
      assert.strictEqual(isCertifiedReview({ [source]: { agent_review_pass_count: count } }), false);
    }
    for (const count of [2, 3, '2']) {
      assert.strictEqual(isCertifiedReview({ [source]: { agent_review_pass_count: count } }), true);
    }
  }
});

test('a truthy review count takes precedence while zero falls back to metadata', () => {
  assert.strictEqual(isCertifiedReview({
    review: { agent_review_pass_count: 1 },
    metadata: { agent_review_pass_count: 3 },
  }), false);
  assert.strictEqual(isCertifiedReview({
    review: { agent_review_pass_count: 0 },
    metadata: { agent_review_pass_count: 2 },
  }), true);
  assert.strictEqual(isCertifiedReview({
    review: { agent_review_pass_count: '0' },
    metadata: { agent_review_pass_count: 2 },
  }), false);
});

test('missing or empty review data is uncertified', () => {
  assert.strictEqual(isCertifiedReview(), false);
  for (const task of [null, {}, { review: {} }, { metadata: {} }, { review: null, metadata: null }]) {
    assert.strictEqual(isCertifiedReview(task), false);
  }
});

test('invalid numeric counts are uncertified unless explicitly certified', () => {
  assert.strictEqual(isCertifiedReview({ review: { agent_review_pass_count: 'invalid' } }), false);
  assert.strictEqual(isCertifiedReview({ metadata: { agent_review_pass_count: 'invalid' } }), false);
  assert.strictEqual(isCertifiedReview({
    review: { agent_review_pass_count: 'invalid' },
    metadata: { agent_certified: true },
  }), true);
});
