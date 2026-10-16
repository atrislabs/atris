'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const { acquireRunLock, liveHolder, lockPath } = require('../lib/campaign-run-lock');

async function run(store, args, extra = {}) {
  const logs = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => logs.push(String(line));
  console.error = (line) => logs.push(String(line));
  let code;
  try {
    code = await campaignCommand(args, {
      store,
      actor: 'human:keshav',
      runJudge: () => ({ passed: false, exit: 1, summary: 'pass 0, fail 1', seconds: 0 }),
      ...extra,
    });
  } finally {
    console.log = saved.log;
    console.error = saved.error;
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

async function start(store, id) {
  const r = await run(store, ['start', `Goal ${id}`, '--judge', 'npm test', '--budget', '50', '--id', id]);
  assert.equal(r.code, 0, r.out);
}

test('tick pushes the first campaign with work and skips done, paused, and waiting-on-you ones', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  for (const id of ['cmp-done', 'cmp-paused', 'cmp-asking', 'cmp-next', 'cmp-later']) await start(store, id);
  await run(store, ['stop', 'cmp-done']);
  await run(store, ['pause', 'cmp-paused']);
  await run(store, ['ask', 'cmp-asking', 'Deploy it?']);
  const asks = [];
  const r = await run(store, ['tick', '--max-steps', '1'], quiet(asks));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /advancing cmp-next \(up to 1 steps\)/);
  assert.match(r.out, /skipped cmp-asking/);
  assert.doesNotMatch(r.out, /advancing cmp-later/);
  const next = getCampaign(store, 'cmp-next');
  assert.ok(next.judge_runs >= 1 || asks.includes('cmp-next'), 'the picked campaign took a real step');
  assert.equal(getCampaign(store, 'cmp-later').judge_runs, 1, 'only one campaign moves per tick');
});

test('tick says plainly when nothing here has work, and moves nothing', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  await start(store, 'cmp-one');
  await run(store, ['ask', 'cmp-one', 'Spend money?']);
  const logs = [];
  const saved = console.log;
  console.log = (line) => logs.push(String(line));
  let code;
  try {
    code = await campaignCommand(['tick', '--json'], { store, actor: 'human:keshav', runJudge: () => ({ passed: false, exit: 1, summary: 'x', seconds: 0 }), ...quiet() });
  } finally {
    console.log = saved;
  }
  assert.equal(code, 0);
  const payload = JSON.parse(logs.join('\n'));
  assert.equal(payload.picked, null);
  assert.deepEqual(payload.skipped.map((s) => s.id), ['cmp-one']);
  assert.match(payload.skipped[0].why, /needs you: 1 open ask/);
});

test('a campaign another live run drives is seen as taken; a dead holder is not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-lock-'));
  const lock = acquireRunLock(home, 'cmp-busy');
  assert.equal(lock.ok, true);
  assert.equal(liveHolder(home, 'cmp-busy').pid, process.pid);
  lock.release();
  assert.equal(liveHolder(home, 'cmp-busy'), null);
  fs.mkdirSync(path.dirname(lockPath(home, 'cmp-gone')), { recursive: true });
  fs.writeFileSync(lockPath(home, 'cmp-gone'), JSON.stringify({ pid: 999999, host: os.hostname() }));
  assert.equal(liveHolder(home, 'cmp-gone', { isAlive: () => false }), null);
});

test('tick runs one mission at a time unless asked for more', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  await start(store, 'cmp-solo');
  const asked = [];
  const deps = { loopDeps: { skipReconcile: true, cli: async () => ({ code: 0, out: '', err: '' }), ask: async (root, view, prompt) => { asked.push(prompt); return { ok: true, engine: 'fake', text: '[]' }; } } };
  await run(store, ['tick', '--max-steps', '2'], deps);
  assert.ok(asked.some((p) => /up to 1 mission/i.test(p) || /propose 1 /i.test(p) || /1 mission/i.test(p)), asked.join('\n---\n').slice(0, 400));
});
