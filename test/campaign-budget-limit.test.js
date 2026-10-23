'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { fold, decide } = require('../lib/campaign-core');
const { checkCampaignStart, reserveCampaignMission } = require('../lib/campaign-missions');
const { syncCampaign, cloudLink } = require('../lib/campaign-sync');

const ID = 'cmp-research';
const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-budget-limit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, kind, budget = 1e9, extra = {}) {
  let clock = Date.parse('2026-10-22T00:00:00Z');
  const options = { origin: 'laptop', now: () => new Date(clock++).toISOString() };
  const store = kind === 'sqlite' ? createSqliteStore(path.join(temporary(t), 'campaign.db'), options) : createMemoryStore(options);
  if (store.close) t.after(() => store.close());
  const append = (type, data = {}, actor = 'executor') => store.append({ campaign_id: ID, type, actor, data });
  append('campaign_started', { title: 'Research', judge: 'exit 1', budget, ...extra });
  append('judge_ran', { passed: false }, 'judge');
  return { store, append };
}

async function command(store, args, extra = {}) {
  const logs = [];
  const saved = { log: console.log, error: console.error };
  console.log = console.error = (line) => logs.push(String(line));
  let code;
  try {
    code = await campaignCommand([...args, '--json'], {
      store, actor: 'executor',
      runJudge: () => assert.fail('setting a ceiling must not run a judge'),
      cloud: { apiRequestJson: () => assert.fail('setting a ceiling must not call the cloud') },
      ...extra,
    });
  } finally {
    Object.assign(console, saved);
  }
  return { code, ...JSON.parse(logs.join('\n')) };
}

for (const kind of ['memory', 'sqlite']) {
  test(`${kind}: a local ceiling preserves history, pause, reservations and recorded spend`, async (t) => {
    const { store, append } = setup(t, kind);
    append('mission_ended', { mission_id: 'old', outcome: 'kept', cost_usd: 3.12 });
    append('budget_reserved', { mission_id: 'next', amount_usd: 6.88 });
    append('paused');
    const before = store.read(ID);
    const result = await command(store, ['budget', ID, '--limit', '10']);
    assert.equal(result.code, 0);
    assert.equal(result.campaign.state, 'paused');
    assert.deepEqual(result.campaign.budget, { total: 10, spent: 3.12, reserved: 6.88, available: 0 });
    assert.equal(result.next.action, 'none');
    assert.deepEqual(store.read(ID).slice(0, -1), before);
    assert.equal(store.read(ID).at(-1).actor, 'executor');
    for (const [amount, message] of [['9.99', /already spent or reserved/], ['10.01', /only lower/]]) {
      const events = store.read(ID);
      const refused = await command(store, ['budget', ID, '--limit', amount]);
      assert.equal(refused.code, 2);
      assert.match(refused.error, message);
      assert.deepEqual(store.read(ID), events);
    }
    assert.equal((await command(store, ['budget', ID, '--limit=10'])).code, 0);
    assert.equal((await command(store, ['budget', ID, '--add', '5'])).campaign.budget.total, 15);
  });

  test(`${kind}: validation and the raw event verb cannot bypass the ceiling checks`, async (t) => {
    const { store, append } = setup(t, kind);
    const before = store.read(ID);
    for (const amount of ['0', '-1', '0.001', '20.001', 'NaN', 'Infinity', '1000000000', '1e2', '']) {
      const result = await command(store, ['budget', ID, '--limit', amount]);
      assert.equal(result.code, 2, amount);
      assert.match(result.error, /whole cents/);
      assert.deepEqual(store.read(ID), before);
    }
    for (const args of [['--limit'], ['--limit', '20', '--add', '5'], ['--limit', '20', '--add=5'], ['--limit', '20', '--limit', '10']]) {
      assert.equal((await command(store, ['budget', ID, ...args])).code, 2);
      assert.deepEqual(store.read(ID), before);
    }
    const raw = await command(store, ['event', ID, 'budget_limited', '--data', '{"amount_usd":20}']);
    assert.equal(raw.code, 2);
    assert.match(raw.error, /cannot be written by hand/);
    assert.deepEqual(store.read(ID), before);
    for (const amount of [0, -1, 0.001, 20.001, Infinity, NaN, 1e9, '20']) {
      assert.throws(() => append('budget_limited', { amount_usd: amount }), /bad_amount/);
      assert.deepEqual(store.read(ID), before);
    }
    assert.equal((await command(store, ['budget', ID, '--limit', '0.01'])).campaign.budget.total, 0.01);
  });

  test(`${kind}: the transactional check sees a reservation made after the command's first read`, async (t) => {
    const { store } = setup(t, kind);
    const append = store.append.bind(store);
    store.append = (event, options) => {
      if (event.type === 'budget_limited') {
        append({ campaign_id: ID, type: 'budget_reserved', actor: 'other-worker', data: { mission_id: 'concurrent', amount_usd: 25 } });
      }
      return append(event, options);
    };
    const result = await command(store, ['budget', ID, '--limit', '20']);
    assert.equal(result.code, 2);
    assert.match(result.error, /\$25.00 already spent or reserved/);
    assert.equal(getCampaign(store, ID).budget.total, 1e9);
    assert.equal(store.read(ID).some((event) => event.type === 'budget_limited'), false);
  });

  test(`${kind}: reduced availability controls new reservations and exhaustion`, async (t) => {
    const { store, append } = setup(t, kind);
    assert.equal((await command(store, ['budget', ID, '--limit', '20'])).code, 0);
    reserveCampaignMission('/unused', ID, 'a', 7, 'executor', { store });
    assert.equal(checkCampaignStart('/unused', ID, { reserveUsd: 13 }, { store }).ok, true);
    assert.equal(checkCampaignStart('/unused', ID, { reserveUsd: 13.01 }, { store }).ok, false);
    const before = store.read(ID);
    assert.throws(() => reserveCampaignMission('/unused', ID, 'b', 13.01, 'executor', { store }), /has \$13.00 left/);
    assert.deepEqual(store.read(ID), before);
    append('mission_ended', { mission_id: 'a', outcome: 'kept', cost_usd: 20 });
    const view = getCampaign(store, ID);
    assert.equal(view.state, 'out_of_budget');
    assert.equal(decide(view).action, 'none');
    assert.equal(checkCampaignStart('/unused', ID, { reserveUsd: 0 }, { store }).ok, false);
  });

  test(`${kind}: a cloud link arriving after the first read still refuses the change`, async (t) => {
    const { store } = setup(t, kind);
    const append = store.append.bind(store);
    store.append = (event, options) => {
      if (event.type === 'budget_limited') store.setMeta(`campaign_sync:${ID}`, JSON.stringify({ link: { url: 'https://example.invalid' } }));
      return append(event, options);
    };
    const before = store.read(ID);
    const result = await command(store, ['budget', ID, '--limit', '20']);
    assert.equal(result.code, 2);
    assert.match(result.error, /cloud campaign/);
    assert.deepEqual(store.read(ID), before);
  });
}

test('the fold cannot use a limit event to increase authority or discard existing commitments', (t) => {
  const { store, append } = setup(t, 'memory', 20);
  append('budget_reserved', { mission_id: 'a', amount_usd: 7 });
  append('budget_limited', { amount_usd: 21 });
  append('budget_limited', { amount_usd: 6.99 });
  const view = fold(store.read(ID));
  assert.deepEqual(view.budget, { total: 20, spent: 0, reserved: 7, available: 13 });
  assert.deepEqual(view.warnings.map((warning) => warning.code), ['budget_limit_would_increase', 'budget_limit_below_commitments']);
});

test('cloud-billed campaigns refuse local limits even before a link is saved', async (t) => {
  const { store } = setup(t, 'memory', 20, { basis: 'atris_cloud' });
  const before = store.read(ID);
  assert.equal((await command(store, ['budget', ID, '--limit', '10'])).code, 2);
  assert.deepEqual(store.read(ID), before);
});

test('sync never copies a local ceiling campaign into an uncapped cloud campaign', async (t) => {
  const { store } = setup(t, 'memory');
  assert.equal((await command(store, ['budget', ID, '--limit', '20'])).code, 0);
  const result = await syncCampaign(store, ID, {
    loadCredentials: () => assert.fail('sync must refuse before reading credentials'),
    apiRequestJson: () => assert.fail('sync must refuse before any request'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /local budget limit/);
  assert.equal(cloudLink(store, ID), null);
});

test('sync rechecks a ceiling committed immediately before its link is saved', async (t) => {
  const { store, append } = setup(t, 'sqlite');
  const setMeta = store.setMeta.bind(store);
  store.setMeta = (key, value) => {
    if (key === `campaign_sync:${ID}`) append('budget_limited', { amount_usd: 20 });
    return setMeta(key, value);
  };
  const result = await syncCampaign(store, ID, {
    loadCredentials: () => assert.fail('sync must refuse before reading credentials'),
    apiRequestJson: () => assert.fail('sync must refuse before any request'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /local budget limit/);
  assert.equal(getCampaign(store, ID).budget.total, 20);
});

test('real CLI saves a ceiling across process restarts and refuses an over-budget mission without creating one', (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# Builder\n');
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(root, 'campaign.db'), ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const start = cli('campaign', 'start', 'Research', '--judge', 'exit 1', '--id', ID, '--as', 'executor', '--json');
  assert.equal(start.status, 0, start.stdout + start.stderr);
  assert.equal(cli('campaign', 'pause', ID, '--as', 'executor', '--json').status, 0);
  const before = createSqliteStore(env.ATRIS_CAMPAIGN_DB);
  const history = before.read(ID);
  before.close();
  const limited = cli('campaign', 'budget', ID, '--limit', '20', '--as', 'executor', '--json');
  assert.equal(limited.status, 0, limited.stdout + limited.stderr);
  const shown = cli('campaign', 'show', ID, '--json');
  assert.equal(shown.status, 0, shown.stderr);
  const view = JSON.parse(shown.stdout).campaign;
  assert.equal(view.state, 'paused');
  assert.deepEqual(view.budget, { total: 20, spent: 0, reserved: 0, available: 20 });
  const reopened = createSqliteStore(env.ATRIS_CAMPAIGN_DB);
  assert.deepEqual(reopened.read(ID).slice(0, -1), history);
  assert.equal(reopened.read(ID).at(-1).type, 'budget_limited');
  reopened.close();
  // Only this disposable fixture resumes; no engine is invoked by an admission refusal.
  assert.equal(cli('campaign', 'resume', ID, '--as', 'executor', '--json').status, 0);
  const refused = cli('mission', 'start', 'Too expensive', '--owner', 'builder', '--no-verify', '--campaign', ID, '--reserve', '20.01', '--json');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /has \$20.00 left/);
  assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'missions.jsonl')), false);
});
