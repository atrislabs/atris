'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const { installKeep, planKeep, removeKeep } = require('../lib/campaign-keep');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 16, 3, 0, 0);

function start(store, id, extra = []) {
  store.append({ campaign_id: id, type: 'campaign_started', actor: 'mission-lead', data: { title: id, judge: 'npm test', budget: 100, owner: 'mission-lead', seats: ['builder'] } });
  store.append({ campaign_id: id, type: 'judge_ran', actor: 'judge', data: { passed: false, exit: 1, summary: '0 of 1', ...(extra.includes('wait') ? { wait: { wake_at: T0 + 10 * MIN, wait_ms: 10 * MIN } } : {}) } });
  if (extra.includes('paused')) store.append({ campaign_id: id, type: 'paused', actor: 'human:keshav', data: {} });
}

async function wake(store, { at = T0, args = [], runJudge, keep } = {}) {
  const logs = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => logs.push(String(line));
  console.error = () => {};
  let code;
  try {
    code = await campaignCommand(['wake', '--json', ...args], {
      store,
      actor: 'mission-lead',
      runJudge: runJudge || (() => ({ passed: false, exit: 1, summary: '0 of 1', seconds: 0 })),
      loopDeps: { now: () => at, skipReconcile: true, cli: async () => ({ code: 0, out: '', err: '' }), ask: async () => ({ ok: true, text: '[]' }), sync: async () => 0 },
      keep,
    });
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
  return { code, body: JSON.parse(logs[logs.length - 1]) };
}

test('wake with no campaigns prints an empty summary and exits 0', async () => {
  const { code, body } = await wake(createMemoryStore());
  assert.equal(code, 0);
  assert.deepEqual([body.ok, body.woke, body.skipped], [true, [], []]);
});

test('wake skips a wait that is not due and a paused campaign, and leaves them untouched', async () => {
  const store = createMemoryStore();
  start(store, 'cmp-waiting', ['wait']);
  start(store, 'cmp-paused', ['paused']);
  const before = { waiting: store.read('cmp-waiting').length, paused: store.read('cmp-paused').length };
  let judged = 0;
  const { code, body } = await wake(store, { at: T0 + 5 * MIN, runJudge: () => { judged += 1; return { passed: false, exit: 1, summary: 'x', seconds: 0 }; } });
  assert.equal(code, 0);
  assert.equal(judged, 0);
  assert.deepEqual(body.woke, []);
  assert.deepEqual(body.skipped.map((s) => s.campaign_id).sort(), ['cmp-paused', 'cmp-waiting']);
  assert.match(body.skipped.find((s) => s.campaign_id === 'cmp-waiting').reason, /^next check at /);
  assert.equal(body.skipped.find((s) => s.campaign_id === 'cmp-paused').reason, 'paused');
  assert.deepEqual({ waiting: store.read('cmp-waiting').length, paused: store.read('cmp-paused').length }, before);
});

test('wake runs one step for a wait that is due, and only the judge runs', async () => {
  const store = createMemoryStore();
  start(store, 'cmp-due', ['wait']);
  let judged = 0;
  const { code, body } = await wake(store, { at: T0 + 11 * MIN, runJudge: () => { judged += 1; return { passed: false, exit: 1, summary: '0 of 1', seconds: 0 }; } });
  assert.equal(code, 0);
  assert.equal(judged, 1);
  assert.equal(body.woke.length, 1);
  assert.equal(body.woke[0].campaign_id, 'cmp-due');
  assert.match(body.woke[0].reason, /nothing changed: next check at/);
  // The same reading backs off: the next wait is about twice as long.
  const next = getCampaign(store, 'cmp-due').next_move;
  assert.ok(next.wake_at - (T0 + 11 * MIN) >= 19 * MIN, JSON.stringify(next));
});

test('a step that throws is reported in the summary and wake still exits 0', async () => {
  const store = createMemoryStore();
  start(store, 'cmp-due', ['wait']);
  const { code, body } = await wake(store, { at: T0 + 11 * MIN, runJudge: () => { throw new Error('judge exploded'); } });
  assert.equal(code, 0);
  assert.equal(body.woke[0].ok, false);
  assert.match(body.woke[0].error, /judge exploded/);
});

test('keep --install --dry-run shows a timer that runs campaign wake and changes nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-home-'));
  try {
    const calls = [];
    const logs = [];
    const saved = console.log;
    console.log = (line) => logs.push(String(line));
    let keepCode;
    try {
      keepCode = await campaignCommand(['keep', '--install', '--dry-run'], { store: createMemoryStore(), actor: 'mission-lead', keep: { plan: { platform: 'darwin', homeDir: home }, spawn: (...a) => { calls.push(a); return { status: 0 }; } } });
    } finally { console.log = saved; }
    assert.equal(keepCode, 0);
    assert.match(logs.join('\n'), /campaign wake --json/);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(home, 'Library')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('keep with neither --install nor --remove says which to pick', async () => {
  const saved = console.error;
  console.error = () => {};
  try {
    assert.equal(await campaignCommand(['keep'], { store: createMemoryStore(), actor: 'mission-lead' }), 2);
  } finally { console.error = saved; }
});

test('the launchd plan runs wake every minute from the checkout, one label per checkout', () => {
  const a = planKeep({ root: '/w/a', home: '/w/a/.atris/state', platform: 'darwin', homeDir: '/h', nodeBin: '/bin/node', atrisBin: '/x/atris.js', envPath: '/usr/bin' });
  const b = planKeep({ root: '/w/b', home: '/w/b/.atris/state', platform: 'darwin', homeDir: '/h', nodeBin: '/bin/node', atrisBin: '/x/atris.js', envPath: '/usr/bin' });
  assert.equal(a.kind, 'launchd');
  assert.notEqual(a.label, b.label);
  assert.match(a.contents, /<string>campaign<\/string><string>wake<\/string><string>--json<\/string>/);
  assert.match(a.contents, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(a.contents, /<key>WorkingDirectory<\/key><string>\/w\/a<\/string>/);
});

test('the cron plan installs once, replaces itself, and removes only its own line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-cron-'));
  try {
    let crontab = '0 * * * * other-job\n';
    const spawn = (cmd, args, opts) => {
      if (args[0] === '-l') return { status: 0, stdout: crontab };
      crontab = opts.input;
      return { status: 0 };
    };
    const plan = planKeep({ root: "/w/it's", home, platform: 'linux', nodeBin: '/bin/node', atrisBin: '/x/atris.js', envPath: '/usr/bin' });
    assert.match(plan.crontab_line, /^\* \* \* \* \* cd '\/w\/it'\\''s' && /);
    assert.ok(installKeep(plan, { spawn }).ok);
    assert.ok(installKeep(plan, { spawn }).ok);
    assert.equal(crontab.split('\n').filter((l) => l.includes(plan.marker)).length, 1);
    assert.match(crontab, /other-job/);
    assert.deepEqual(removeKeep(plan, { spawn }), { ok: true, removed: true });
    assert.equal(crontab, '0 * * * * other-job\n');
    assert.deepEqual(removeKeep(plan, { spawn }), { ok: true, removed: false });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
