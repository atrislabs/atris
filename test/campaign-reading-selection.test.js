'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMemoryStore } = require('../lib/campaign-store');
const { summarizeStoreRsi, selectNextCampaigns } = require('../lib/campaign-rsi');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

test('next selection uses the same real reading for numeric and summary-backed measurements', () => {
  const store = createMemoryStore({ origin: 'reading-test' });
  for (const [id, data] of [
    ['cmp-low', { passed: false, reading: 0.4 }],
    ['cmp-high', { passed: false, summary: '8 of 10 live' }],
  ]) {
    store.append({ campaign_id: id, type: 'campaign_started', actor: 'owner',
      data: { title: 'Improve real results', owner: 'owner', judge: 'exit 1', budget: 10 } });
    store.append({ campaign_id: id, type: 'judge_ran', actor: 'judge', data });
  }
  const summary = summarizeStoreRsi(store);
  assert.equal(summary.campaigns.find(c => c.campaign_id === 'cmp-high').reading, 0.8);
  const next = selectNextCampaigns(store, summary);
  assert.deepEqual(next.map(c => [c.id, c.reading]), [['cmp-high', 0.8], ['cmp-low', 0.4]]);
});

test('actual identical judge scores keep their first choice and fair overnight order after a reset', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-selection-reading-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const product = path.join(root, 'product.txt');
  const original = Buffer.from('unchanged product\n');
  fs.writeFileSync(product, original);
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(root, '.atris', 'state', 'atris.db'),
    ATRIS_RSI_STATE: path.join(root, 'owned-rsi'), ATRIS_TEST_STATE_DIR: path.join(root, 'owned-user-state'),
    ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.NODE_TEST_CONTEXT;
  const run = (args, expected = 0) => {
    const r = spawnSync(process.execPath, [CLI, 'campaign', ...args, '--as', 'owner', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(r.error);
    assert.equal(r.status, expected, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const high = "printf '8 of 10 live\\n'; exit 1";
  for (const [id, judge] of [['cmp-low', "printf '4 of 10 live\\n'; exit 1"], ['cmp-high', high]]) {
    run(['start', 'Improve a real result', '--judge', judge, '--owner', 'owner', '--budget', '10', '--id', id]);
  }
  const views = () => ['cmp-low', 'cmp-high'].map(id => run(['show', id]).campaign);
  const sample = () => {
    const report = run(['rsi', '--next', '--no-write']);
    const before = views();
    const one = run(['rsi', '--loop', '--dry-run', '--rounds', '1']);
    const two = run(['rsi', '--loop', '--dry-run', '--rounds', '2']);
    assert.deepEqual(views(), before, 'preview must neither run judges nor change campaign events');
    for (const c of report.rsi.campaigns) {
      assert.equal(c.total_reward, 0);
      assert.equal(c.missions.length, 0);
      assert.equal(c.reading, c.campaign_id === 'cmp-high' ? 0.8 : 0.4);
    }
    for (const cycle of [...one.cycles, ...two.cycles]) {
      assert.equal(cycle.dry_run, true);
      assert.equal(cycle.step, null);
      assert.deepEqual(cycle.auto_seated, []);
    }
    assert.equal(new Set(two.cycles.map(c => c.top_campaign)).size, 2, 'both campaigns still get their turn');
    assert.deepEqual(fs.readFileSync(product), original);
    return { reading: report.next_campaigns.find(c => c.id === 'cmp-high').reading,
      next: report.next_campaigns[0].id, first: one.cycles[0].top_campaign,
      order: two.cycles.map(c => c.top_campaign) };
  };
  const stages = [sample()];
  const reset = run(['set-judge', 'cmp-high', high]);
  assert.equal(reset.campaign.judge, high, 'the actual measuring command has not changed');
  assert.equal(reset.campaign.last_judge.reading, 0.8, 'the reset retains the actual measured score');
  assert.equal(reset.campaign.answer.text, '8 of 10 live');
  stages.push(sample());
  run(['judge', 'cmp-high'], 1);
  stages.push(sample());
  assert.deepEqual(stages, Array.from({ length: 3 }, () => ({ reading: 0.8, next: 'cmp-high', first: 'cmp-high', order: ['cmp-high', 'cmp-low'] })));
  assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'attempts.jsonl')), false);
  assert.equal(fs.existsSync(path.join(env.ATRIS_RSI_STATE, 'dreams.jsonl')), false);
});
