'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, closeCampaignStores } = require('../lib/campaign-store');
const { nextAt, parseEvery, readSchedule, scheduleFile } = require('../lib/campaign-schedule');

const MIN = 60000;
// A Thursday, 08:00 local time.
const T0 = new Date(2026, 9, 15, 8, 0, 0).getTime();

function start(store, id, budget = 20) {
  store.append({ campaign_id: id, type: 'campaign_started', actor: 'human:keshav', data: { title: id, judge: 'npm test', budget, owner: 'mission-lead', seats: ['builder'] } });
  store.append({ campaign_id: id, type: 'judge_ran', actor: 'judge', data: { passed: false, exit: 1, summary: '0 of 1' } });
}

async function run(store, home, args, { at = T0, actor = 'human:keshav', judged } = {}) {
  const logs = [];
  const saved = { log: console.log, error: console.error };
  const previousDb = process.env.ATRIS_CAMPAIGN_DB;
  process.env.ATRIS_CAMPAIGN_DB = path.join(home, 'campaign.db');
  console.log = (line) => logs.push(String(line));
  console.error = () => {};
  let code;
  try {
    code = await campaignCommand([...args, '--json'], {
      store,
      actor,
      campaignHome: home,
      runJudge: () => { if (judged) judged.count += 1; return { passed: false, exit: 1, summary: '0 of 1', seconds: 0 }; },
      loopDeps: { now: () => at, skipReconcile: true, cli: async () => ({ code: 0, out: '', err: '' }), ask: async () => ({ ok: true, text: '[]' }), sync: async () => 0 },
    });
  } finally {
    try { closeCampaignStores(); } finally {
      if (previousDb === undefined) delete process.env.ATRIS_CAMPAIGN_DB;
      else process.env.ATRIS_CAMPAIGN_DB = previousDb;
      console.log = saved.log;
      console.error = saved.error;
    }
  }
  return { code, body: JSON.parse(logs[logs.length - 1]) };
}

function makeTempDir(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

const tmpHome = (t) => makeTempDir(t, 'atris-schedule-');

test('parseEvery reads intervals, days, and clock times, and refuses what it cannot read', () => {
  assert.deepEqual(parseEvery('30m').rule, { kind: 'interval', ms: 30 * MIN });
  assert.deepEqual(parseEvery('2h').rule, { kind: 'interval', ms: 120 * MIN });
  assert.deepEqual(parseEvery('weekdays 09:00').rule, { kind: 'clock', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
  assert.deepEqual(parseEvery('Thu,mon 7:05').rule, { kind: 'clock', days: [1, 4], hour: 7, minute: 5 });
  assert.deepEqual(parseEvery('18:30').rule.days, [0, 1, 2, 3, 4, 5, 6]);
  for (const bad of ['', 'soon', '0m', '25:00', 'someday 09:00', 'weekdays at 09:00']) assert.ok(parseEvery(bad).error, bad);
});

test('nextAt finds the next allowed day, skipping the weekend', () => {
  const weekdays = parseEvery('weekdays 09:00').rule;
  assert.equal(nextAt(weekdays, T0), new Date(2026, 9, 15, 9, 0).getTime(), 'later the same Thursday');
  const fridayNoon = new Date(2026, 9, 16, 12, 0).getTime();
  assert.equal(nextAt(weekdays, fridayNoon), new Date(2026, 9, 19, 9, 0).getTime(), 'Friday afternoon rolls to Monday');
  assert.equal(nextAt(parseEvery('5m').rule, T0), T0 + 5 * MIN);
  assert.equal(nextAt(parseEvery('1m').rule, T0 + 19000), T0 + MIN, 'an interval slot lands on the minute it shows');
});

test('only a person can set a schedule, and only on a campaign with a budget', async (t) => {
  const store = createMemoryStore();
  const home = tmpHome(t);
  start(store, 'cmp-a');
  start(store, 'cmp-open', 1e9);
  const agent = await run(store, home, ['schedule', 'cmp-a', '--every', 'weekdays 09:00'], { actor: 'mission-lead' });
  assert.equal(agent.code, 2);
  assert.match(agent.body.error, /only a person can set one/);
  assert.equal(readSchedule(home, 'cmp-a'), null);
  const open = await run(store, home, ['schedule', 'cmp-open', '--every', 'daily 09:00']);
  assert.equal(open.code, 2);
  assert.match(open.body.error, /has no budget/);
  const bad = await run(store, home, ['schedule', 'cmp-a', '--every', 'whenever']);
  assert.equal(bad.code, 2);
  const ok = await run(store, home, ['schedule', 'cmp-a', '--every', 'weekdays 09:00', '--steps', '2']);
  assert.equal(ok.code, 0, JSON.stringify(ok.body));
  assert.equal(ok.body.schedule.approved_by, 'human:keshav');
  assert.equal(ok.body.schedule.steps, 2);
  assert.equal(ok.body.schedule.next_at, new Date(2026, 9, 15, 9, 0).getTime());
  // An agent can still take a schedule away.
  const off = await run(store, home, ['schedule', 'cmp-a', '--off'], { actor: 'mission-lead' });
  assert.equal(off.code, 0);
  assert.equal(off.body.removed, true);
  assert.equal(fs.existsSync(scheduleFile(home, 'cmp-a')), false);
});

test('wake leaves a scheduled campaign alone until its time, then runs it once and books the next slot', async (t) => {
  const store = createMemoryStore();
  const home = tmpHome(t);
  start(store, 'cmp-daily');
  await run(store, home, ['schedule', 'cmp-daily', '--every', 'daily 09:00', '--steps', '1']);
  const judged = { count: 0 };
  const early = await run(store, home, ['wake'], { at: T0 + 30 * MIN, judged });
  assert.deepEqual(early.body.woke, []);
  assert.match(early.body.skipped[0].reason, /^scheduled: next run /);
  assert.equal(judged.count, 0);

  const due = await run(store, home, ['wake'], { at: T0 + 61 * MIN, judged });
  assert.equal(due.body.woke.length, 1, JSON.stringify(due.body));
  assert.equal(due.body.woke[0].scheduled, true);
  assert.match(due.body.woke[0].reason, /proposed nothing/, "a real run asked the owner for work");
  const saved = readSchedule(home, 'cmp-daily');
  assert.equal(saved.next_at, new Date(2026, 9, 16, 9, 0).getTime(), 'the next slot is tomorrow');
  assert.ok(saved.last_fired_at);

  const again = await run(store, home, ['wake'], { at: T0 + 62 * MIN, judged });
  assert.deepEqual(again.body.woke, [], 'a slot fires once');
});

test('tick skips a scheduled campaign that is not due and pushes the next one', async (t) => {
  const store = createMemoryStore();
  const home = tmpHome(t);
  start(store, 'cmp-sched');
  start(store, 'cmp-free');
  await run(store, home, ['schedule', 'cmp-sched', '--every', 'weekdays 09:00']);
  const early = await run(store, home, ['tick', '--max-steps', '1'], { at: T0 + 5 * MIN });
  assert.equal(early.code, 0);
  const skipped = (early.body.skipped || []).map((s) => s.id);
  assert.ok(skipped.includes('cmp-sched') || early.body.campaign?.id === 'cmp-free', JSON.stringify(early.body));
  assert.equal(readSchedule(home, 'cmp-sched').last_fired_at, null, 'the slot is not used up early');

  await run(store, home, ['stop', 'cmp-free']);
  const due = await run(store, home, ['tick', '--max-steps', '1'], { at: T0 + 61 * MIN });
  assert.equal(due.code, 0, JSON.stringify(due.body));
  assert.ok(readSchedule(home, 'cmp-sched').last_fired_at, 'tick fired the due slot');
});
