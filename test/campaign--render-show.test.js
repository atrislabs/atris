'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// renderShow opens the campaign store next to the working folder to look up
// seat ratings. Point that store, HOME, and the working folder at a scratch
// folder, and clear every ATRIS_* variable, before the command loads.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-render-show-'));
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ATRIS_')) delete process.env[name];
}
process.env.HOME = scratch;
process.env.ATRIS_CAMPAIGN_DB = path.join(scratch, 'state', 'atris.db');
process.chdir(scratch);

const { renderShow } = require('../commands/campaign');
const { closeCampaignStores } = require('../lib/campaign-store');

test.after(() => {
  closeCampaignStores();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.ATRIS_CAMPAIGN_DB;
  fs.rmSync(scratch, { recursive: true, force: true });
});

// A folded campaign view with every field renderShow reads; tests override what they care about.
function makeView(overrides = {}) {
  return {
    id: 'cmp-ship',
    title: 'Ship campaigns',
    state: 'running',
    stop_reason: null,
    judge: 'npm run validate:campaign',
    last_judge: { passed: false, at: '2026-01-02T03:04:05.000Z' },
    judge_due: false,
    answer: { confidence: 'low', text: '' },
    budget: { total: 20, spent: 5, reserved: 2, available: 13 },
    basis: 'own_engines',
    owner: 'keshav',
    standing: false,
    bet: null,
    parent: null,
    seats: [{ member: 'builder', role: 'build' }],
    missions: [{ id: 'm-1', status: 'running', member: 'builder', outcome: null, cost_usd: 1.5, estimate_usd: 2 }],
    asks: [],
    warnings: [],
    ...overrides,
  };
}

test('renderShow lays out a running campaign on a subscription, without dollar amounts', () => {
  const out = renderShow(makeView());
  assert.deepEqual(out.split('\n'), [
    'Ship campaigns  (cmp-ship)',
    '',
    'state     running · next: wait: missions running (atris campaign show cmp-ship)',
    'judge     npm run validate:campaign · last run failed at 2026-01-02T03:04:05.000Z',
    'answer    low',
    'budget    on your subscription, nothing spent · 25% of the budget used',
    'owner     keshav',
    'seats     builder (build)',
    'missions  ',
    '  m-1                    running  builder',
    'asks      none',
  ]);
  assert.ok(!out.includes('$'), 'no dollar figure when the person pays nothing');
});

test('renderShow shows real dollars when atris_cloud pays for the engines', () => {
  const out = renderShow(makeView({ basis: 'atris_cloud' }));
  const lines = out.split('\n');
  assert.ok(lines.includes('budget    $5.00 spent of $20.00 · $2.00 reserved · $13.00 left'));
  assert.ok(lines.includes('  m-1                    running  builder · $1.50'));
});

test('renderShow shows bet, parent, standing owner, finished missions, and a stop reason', () => {
  const view = makeView({
    state: 'out_of_budget',
    stop_reason: 'budget_spent',
    standing: true,
    bet: { text: 'a faster judge wins', wrong_if: 'the judge stays slow' },
    parent: 'cmp-root',
    answer: { confidence: 'high', text: 'ship it' },
    last_judge: { passed: true, at: '2026-02-03T04:05:06.000Z' },
    judge_due: true,
    seats: [{ member: 'builder', role: 'build' }, { member: 'checker' }],
    missions: [
      { id: 'm-1', status: 'done', member: 'builder', outcome: 'kept', cost_usd: null, estimate_usd: 1 },
      { id: 'm-2', status: 'failed', member: null, outcome: null, cost_usd: 0.25, estimate_usd: 1 },
    ],
  });
  assert.deepEqual(renderShow(view).split('\n'), [
    'Ship campaigns  (cmp-ship)',
    '',
    'state     out of budget (budget spent) · next: nothing to do: budget spent',
    'judge     npm run validate:campaign · last run passed at 2026-02-03T04:05:06.000Z · due again',
    'answer    high: ship it',
    'budget    on your subscription, nothing spent · 25% of the budget used',
    'owner     keshav · standing (a passing judge means healthy, not done)',
    'bet       a faster judge wins · wrong if the judge stays slow',
    'parent    cmp-root',
    'seats     builder (build), checker',
    'missions  ',
    '  m-1                    done     builder · kept',
    '  m-2                    failed   -',
    'asks      none',
  ]);
});

test('renderShow handles a brand new campaign: nothing run, nothing seated, no spending limit', () => {
  const view = makeView({
    state: 'queued',
    judge_due: true,
    last_judge: null,
    budget: { total: 1e9, spent: 0, reserved: 0, available: 1e9 },
    seats: [],
    missions: [],
  });
  const out = renderShow(view);
  assert.deepEqual(out.split('\n'), [
    'Ship campaigns  (cmp-ship)',
    '',
    'state     queued · next: run the judge: atris campaign judge cmp-ship',
    'judge     npm run validate:campaign · never run',
    'answer    low',
    'owner     keshav',
    'seats     none',
    'missions  none',
    'asks      none',
  ]);
  assert.ok(!out.includes('budget'), 'a campaign with no limit leaves the money line out');
});

test('renderShow lists open asks, warnings, and tells the person how to answer', () => {
  const view = makeView({
    state: 'needs_you',
    missions: [{ id: 'm-2', status: 'claimed', member: null, outcome: null, cost_usd: null, estimate_usd: 1 }],
    asks: [{ id: 'a-1', question: 'Delete the old table?', mission_id: 'm-2' }],
    warnings: [{ code: 'bad_event', event_id: 'evt-9' }, { code: 'late_cost', event_id: 'evt-10' }],
  });
  assert.deepEqual(renderShow(view).split('\n').slice(2), [
    'state     needs you · next: answer 1 open ask: atris campaign answer cmp-ship a-1 "<answer>"',
    'judge     npm run validate:campaign · last run failed at 2026-01-02T03:04:05.000Z',
    'answer    low',
    'budget    on your subscription, nothing spent · 25% of the budget used',
    'owner     keshav',
    'seats     builder (build)',
    'missions  ',
    '  m-2                    claimed  -',
    'asks      ',
    '  a-1: Delete the old table?',
    'warnings  ',
    '  bad event (evt-9)',
    '  late cost (evt-10)',
  ]);
});

test('renderShow cuts a long title to 80 characters', () => {
  const title = 'x'.repeat(90);
  const first = renderShow(makeView({ title })).split('\n')[0];
  assert.equal(first, `${'x'.repeat(77)}...  (cmp-ship)`);
  assert.equal(renderShow(makeView({ title: 'y'.repeat(80) })).split('\n')[0], `${'y'.repeat(80)}  (cmp-ship)`);
});

test('renderShow does not change the view it is given', () => {
  const view = makeView({ asks: [{ id: 'a-1', question: 'Go?', mission_id: null }] });
  const before = JSON.stringify(view);
  renderShow(view);
  assert.equal(JSON.stringify(view), before);
});

test('renderShow throws on a missing or empty view instead of printing a half page', () => {
  assert.throws(() => renderShow(undefined), TypeError);
  assert.throws(() => renderShow({}), TypeError);
});
