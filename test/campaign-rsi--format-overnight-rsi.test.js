'use strict';

const test = require('node:test');
const assert = require('node:assert');

// formatOvernightRsi reads no env, disk, or clock. The modules it loads read
// ATRIS_* settings when called, so clear them so nothing leaks in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { formatOvernightRsi } = require('../lib/campaign-rsi');

function rsi(overrides = {}) {
  return {
    total_reward: 0.5,
    completed_count: 1,
    campaigns_count: 3,
    ...overrides,
  };
}

test('formats a two-cycle night with a preview, a real step, and one open campaign', () => {
  const text = formatOvernightRsi({
    ok: true,
    rounds: 2,
    rsi: rsi(),
    cycles: [
      { cycle: 1, dry_run: true, top_campaign: 'cmp-a', step: null },
      { cycle: 2, dry_run: false, top_campaign: 'cmp-b', step: { ok: true, did: 'shipped mission m-7' } },
    ],
    next_campaigns: [
      { id: 'cmp-b', state: 'running', reading: 0.25, recommendation: 'run next round with executor (80 ovr)' },
    ],
  });

  assert.strictEqual(text, [
    'overnight rsi: 2 cycles · +0.5 reading · 1/3 done',
    '  cycle 1: cmp-a · preview',
    '  cycle 2: cmp-b · did: shipped mission m-7',
    'next campaigns: 1 open',
    '  cmp-b (running · reading 0.25) -> run next round with executor (80 ovr)',
  ].join('\n'));
});

test('uses singular wording, shows a stopped step, and reports an empty queue', () => {
  const text = formatOvernightRsi({
    ok: false,
    rounds: 1,
    rsi: rsi({ total_reward: 0, completed_count: 0, campaigns_count: 0 }),
    cycles: [
      { cycle: 1, dry_run: false, top_campaign: null, step: { ok: true, stop: true, reason: 'budget spent' } },
    ],
    next_campaigns: [],
  });

  assert.strictEqual(text, [
    'overnight rsi: 1 cycle · +0 reading · 0/0 done',
    '  cycle 1: no open campaign · stopped: budget spent',
    'next campaigns: none open (all campaigns done or paused)',
  ].join('\n'));
});

test('reports each failed step as its error, its reason, or no result', () => {
  const text = formatOvernightRsi({
    ok: false,
    rounds: 3,
    rsi: rsi(),
    cycles: [
      { cycle: 1, dry_run: false, top_campaign: 'cmp-a', step: { ok: false, error: 'runner crashed' } },
      { cycle: 2, dry_run: false, top_campaign: 'cmp-a', step: { ok: false, reason: 'lock held' } },
      { cycle: 3, dry_run: false, top_campaign: 'cmp-a', step: null },
    ],
    next_campaigns: [],
  });

  assert.strictEqual(text, [
    'overnight rsi: 3 cycles · +0.5 reading · 1/3 done',
    '  cycle 1: cmp-a · failed: runner crashed',
    '  cycle 2: cmp-a · failed: lock held',
    '  cycle 3: cmp-a · failed: no result',
    'next campaigns: none open (all campaigns done or paused)',
  ].join('\n'));
});
