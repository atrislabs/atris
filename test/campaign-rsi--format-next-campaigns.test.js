'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatNextCampaigns } = require('../lib/campaign-rsi');

const NONE_OPEN = 'next campaigns: none open (all campaigns done or paused)';

test('formatNextCampaigns prints a header count and one indented line per campaign, in the order given', () => {
  const list = [
    { id: 'camp-a', state: 'open', reading: 0.25, recommendation: 'bench bo; route next mission to cy (81 ovr)' },
    { id: 'camp-b', state: 'open', reading: 0.75, recommendation: 'run next round with ada (72 ovr)' },
  ];

  assert.strictEqual(
    formatNextCampaigns(list),
    [
      'next campaigns: 2 open',
      '  camp-a (open · reading 0.25) -> bench bo; route next mission to cy (81 ovr)',
      '  camp-b (open · reading 0.75) -> run next round with ada (72 ovr)',
    ].join('\n'),
  );
});

test('formatNextCampaigns keeps a zero reading visible and handles a single campaign', () => {
  const list = [
    { id: 'camp-solo', state: 'open', reading: 0, recommendation: 'add seat cy (top ovr) to replace cold lineup' },
  ];

  assert.strictEqual(
    formatNextCampaigns(list),
    [
      'next campaigns: 1 open',
      '  camp-solo (open · reading 0) -> add seat cy (top ovr) to replace cold lineup',
    ].join('\n'),
  );
});

test('formatNextCampaigns returns the none-open line for empty or non-list input', () => {
  assert.strictEqual(formatNextCampaigns([]), NONE_OPEN);
  assert.strictEqual(formatNextCampaigns(null), NONE_OPEN);
  assert.strictEqual(formatNextCampaigns(undefined), NONE_OPEN);
  assert.strictEqual(formatNextCampaigns({}), NONE_OPEN);
  assert.strictEqual(formatNextCampaigns('camp-a'), NONE_OPEN);
});
