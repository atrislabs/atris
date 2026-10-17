'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign, closeCampaignStores } = require('../lib/campaign-store');
const { acquireRunLock, liveHolder, lockPath } = require('../lib/campaign-run-lock');

function makeTempDir(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

async function run(store, home, args, extra = {}) {
  const logs = [];
  const saved = { log: console.log, error: console.error };
  const previousDb = process.env.ATRIS_CAMPAIGN_DB;
  process.env.ATRIS_CAMPAIGN_DB = path.join(home, 'campaign.db');
  console.log = (line) => logs.push(String(line));
  console.error = (line) => logs.push(String(line));
  let code;
  try {
    code = await campaignCommand(args, {
      store,
      actor: 'human:keshav',
      campaignHome: home,
      runJudge: () => ({ passed: false, exit: 1, summary: 'pass 0, fail 1', seconds: 0 }),
      ...extra,
    });
  } finally {
    try { closeCampaignStores(); } finally {
      if (previousDb === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
      else process.env.ATRIS_CAMPAIGN_DB = previousDb;
      console.log = saved.log;
      console.error = saved.error;
    }
  }
  return { code, out: logs.join('\n') };
}

const quiet = (asks = []) => ({
  loopDeps: {
    skipReconcile: true,
    cli: async () => ({ code: 0, out: '', err: '' }),
    ask: async (root, view) => { asks.push(view.id); return { ok: true, engine: 'fake', text: '[]' }; },
  },
});

async function start(store, home, id) {
  const r = await run(store, home, ['start', `Goal ${id}`, '--judge', 'npm test', '--budget', '50', '--id', id]);
  assert.equal(r.code, 0, r.out);
}

// Waiting on you: the campaign's only queued job is held by a question that names it.
// A question that names no job holds nothing (atris/features/campaign/promise.md).
function holdOnYou(store, id, question) {
  const mission = `m-${id}`;
  store.append({ campaign_id: id, type: 'mission_proposed', actor: 'builder', data: { mission_id: mission, member: 'builder', objective: question } });
  store.append({ campaign_id: id, type: 'mission_claimed', actor: 'builder', data: { mission_id: mission, claim_key: question.toLowerCase() } });
  store.append({ campaign_id: id, type: 'ask_opened', actor: 'mission-lead', data: { ask_id: `a-${id}`, question, mission_id: mission } });
}

test('tick pushes the first campaign with work and skips done, paused, and waiting-on-you ones', async (t) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const home = makeTempDir(t, 'atris-campaign-tick-');
  for (const id of ['cmp-done', 'cmp-paused', 'cmp-asking', 'cmp-next', 'cmp-later']) await start(store, home, id);
  await run(store, home, ['stop', 'cmp-done']);
  await run(store, home, ['pause', 'cmp-paused']);
  holdOnYou(store, 'cmp-asking', 'Deploy it?');
  const asks = [];
  const r = await run(store, home, ['tick', '--max-steps', '1'], quiet(asks));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /proposed nothing usable/);
  assert.match(r.out, /advancing cmp-next \(up to 1 steps\)/);
  assert.match(r.out, /skipped cmp-asking/);
  assert.doesNotMatch(r.out, /advancing cmp-later/);
  const next = getCampaign(store, 'cmp-next');
  assert.ok(next.judge_runs >= 1 || asks.includes('cmp-next'), 'the picked campaign took a real step');
  assert.equal(getCampaign(store, 'cmp-later').judge_runs, 1, 'only one campaign moves per tick');
});

test('tick says plainly when nothing here has work, and moves nothing', async (t) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const home = makeTempDir(t, 'atris-campaign-tick-');
  await start(store, home, 'cmp-one');
  holdOnYou(store, 'cmp-one', 'Spend money?');
  const logs = [];
  const saved = console.log;
  const previousDb = process.env.ATRIS_CAMPAIGN_DB;
  process.env.ATRIS_CAMPAIGN_DB = path.join(home, 'campaign.db');
  console.log = (line) => logs.push(String(line));
  let code;
  try {
    code = await campaignCommand(['tick', '--json'], { store, campaignHome: home, actor: 'human:keshav', runJudge: () => ({ passed: false, exit: 1, summary: 'x', seconds: 0 }), ...quiet() });
  } finally {
    try { closeCampaignStores(); } finally {
      if (previousDb === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
      else process.env.ATRIS_CAMPAIGN_DB = previousDb;
      console.log = saved;
    }
  }
  assert.equal(code, 0);
  const payload = JSON.parse(logs.join('\n'));
  assert.equal(payload.picked, null);
  assert.deepEqual(payload.skipped.map((s) => s.id), ['cmp-one']);
  assert.match(payload.skipped[0].why, /needs you: 1 open ask/);
});

test('a campaign another live run drives is seen as taken; a dead holder is not', (t) => {
  const home = makeTempDir(t, 'tick-lock-');
  const lock = acquireRunLock(home, 'cmp-busy');
  assert.equal(lock.ok, true);
  assert.equal(liveHolder(home, 'cmp-busy').pid, process.pid);
  lock.release();
  assert.equal(liveHolder(home, 'cmp-busy'), null);
  fs.mkdirSync(path.dirname(lockPath(home, 'cmp-gone')), { recursive: true });
  fs.writeFileSync(lockPath(home, 'cmp-gone'), JSON.stringify({ pid: 999999, host: os.hostname() }));
  assert.equal(liveHolder(home, 'cmp-gone', { isAlive: () => false }), null);
});

test('tick runs one mission at a time unless asked for more', async (t) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const home = makeTempDir(t, 'atris-campaign-tick-');
  await start(store, home, 'cmp-solo');
  const asked = [];
  const deps = { loopDeps: { skipReconcile: true, cli: async () => ({ code: 0, out: '', err: '' }), ask: async (root, view, prompt) => { asked.push(prompt); return { ok: true, engine: 'fake', text: '[]' }; } } };
  await run(store, home, ['tick', '--max-steps', '2'], deps);
  assert.ok(asked.some((p) => /up to 1 mission/i.test(p) || /propose 1 /i.test(p) || /1 mission/i.test(p)), asked.join('\n---\n').slice(0, 400));
});
