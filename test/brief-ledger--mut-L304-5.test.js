'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBriefReview } = require('../lib/brief-ledger');

test('brief review labels exactly one minute to land as 1m', () => {
  const output = renderBriefReview({
    count: 1,
    groups: {
      pass: [{
        prompt_text: 'A bounded change',
        signals: {
          engine: 'local',
          prompt_words: 3,
          has_named_verify: true,
          had_exit_criteria: true,
          time_to_land_ms: 60000,
        },
      }],
    },
  });

  assert.equal(output, [
    'brief review: 1 recent briefs | pass 1, partial 0, fail 0, open 0',
    '',
    'pass: recorded',
    '- local | 3 words | verify yes | exit yes | land 1m | A bounded change',
    '',
    'partial: none',
    '',
    'fail: none',
    '',
    'open: none',
  ].join('\n'));
});
