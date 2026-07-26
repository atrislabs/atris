'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { formatScoreboardPnl } = require('../commands/fleet-report');

test('no scoreboard yields no pnl line', () => {
  assert.strictEqual(formatScoreboardPnl(null), '');
  assert.strictEqual(formatScoreboardPnl(undefined), '');
});

test('a missing compute cost never renders as $NaN to the owner', () => {
  // ec2 cost present, compute cost absent: the old code did undefined + 0 = NaN
  const line = formatScoreboardPnl({ revenue_mrr_usd: 500, ec2_cost_usd: 3, profit_daily_usd: 12 });
  assert.ok(!line.includes('NaN'), `pnl leaked NaN: ${line}`);
  assert.strictEqual(line, ' | mrr $500 cost $3.00/d profit $12/d');
});

test('missing mrr and profit render as $0, never $undefined', () => {
  const line = formatScoreboardPnl({ ec2_cost_usd: 3 });
  assert.ok(!line.includes('undefined'), `pnl leaked undefined: ${line}`);
  assert.strictEqual(line, ' | mrr $0 cost $3.00/d profit $0/d');
});

test('both cost sources sum when present', () => {
  const line = formatScoreboardPnl({
    revenue_mrr_usd: 1000,
    compute_cost_usd: 2.5,
    ec2_cost_usd: 1.5,
    profit_daily_usd: 30,
  });
  assert.strictEqual(line, ' | mrr $1000 cost $4.00/d profit $30/d');
});
