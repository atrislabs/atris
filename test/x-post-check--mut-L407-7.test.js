'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkXPosts } = require('../lib/x-post-check');

test('checks a post discovered only through an inline status link', async () => {
  const id = '1234567890123456789';
  const text = 'Small gardens provide fresh vegetables throughout summer';
  const result = await checkXPosts({
    content: `${text}\nhttps://x.com/gardener/status/${id}`,
    citations: [],
    fetchPost: async (requestedId) => {
      assert.equal(requestedId, id);
      return {
        id,
        ok: true,
        post: { id, handle: 'gardener', text, createdAt: null },
      };
    },
  });

  assert.deepStrictEqual(result, {
    checks: [{
      status: 'checked',
      handle: 'gardener',
      id,
      url: `https://x.com/gardener/status/${id}`,
      text,
      posted_at: null,
      line: null,
    }],
    tally: { checked: 1, unverified: 0, unknown: 0 },
    otherSources: [],
  });
});
