'use strict';

// Campaign cloud sync against an in-process fake of the cloud routes in
// atris/features/campaign/api.md: idempotent by event id, refuses a second
// event at the same origin and seq (409), refuses person-only events from a
// computer (403), and lets a phone answer an ask.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, createSqliteStore, getCampaign } = require('../lib/campaign-store');
const { cloudLink, syncCampaign } = require('../lib/campaign-sync');
const { decide } = require('../lib/campaign-core');

const PERSON_ONLY = new Set(['ask_answered', 'budget_added', 'done']);
const loggedIn = { loadCredentials: () => ({ token: 'test-token' }) };

function fakeCloud() {
  const events = [];
  const requests = [];
  const state = { refuse: null, cloudSeq: 0 };
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const lastSeq = () => events.length;
  const cloudEvent = (campaignId, type, data) => {
    state.cloudSeq += 1;
    events.push({ id: `evt-cloud-${state.cloudSeq}`, campaign_id: campaignId, type, at: new Date().toISOString(), origin: 'cloud', seq: state.cloudSeq, actor: 'human:phone', data });
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
      if (req.headers.authorization !== 'Bearer test-token') return send(res, 401, { ok: false, error: 'sign in first' });
      if (state.refuse) return send(res, state.refuse.status, { ok: false, error: state.refuse.error });
      const match = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/(events|asks\/([^/]+)\/answer|actions)$/);
      if (!match) return send(res, 404, { ok: false, error: 'no such route' });
      const campaignId = decodeURIComponent(match[1]);
      const body = raw ? JSON.parse(raw) : {};
      const mine = () => events.filter((e) => e.campaign_id === campaignId);
      if (match[2] === 'events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after')) || 0;
        const limit = Number(url.searchParams.get('limit')) || 500;
        const page = events.map((e, i) => ({ e, seq: i + 1 })).filter((x) => x.e.campaign_id === campaignId && x.seq > after).slice(0, limit);
        return send(res, 200, { ok: true, events: page.map((x) => x.e), last_event_seq: page.length ? page[page.length - 1].seq : Math.max(after, 0) });
      }
      if (match[2] === 'events' && req.method === 'POST') {
        const incoming = body.events || [];
        if (!mine().length && !incoming.some((e) => e.type === 'campaign_started')) return send(res, 409, { ok: false, error: 'the first push must include campaign_started' });
        const blocked = incoming.find((e) => PERSON_ONLY.has(e.type));
        if (blocked) return send(res, 403, { ok: false, error: `a computer cannot send ${blocked.type}; only a person can` });
        let accepted = 0;
        let duplicates = 0;
        for (const event of incoming) {
          if (events.some((e) => e.id === event.id)) { duplicates += 1; continue; }
          if (events.some((e) => e.origin === event.origin && e.seq === event.seq)) return send(res, 409, { ok: false, error: `origin ${event.origin} seq ${event.seq} is already taken` });
          events.push(event);
          accepted += 1;
        }
        return send(res, 200, { ok: true, accepted, duplicates, last_event_seq: lastSeq() });
      }
      if (match[3]) {
        cloudEvent(campaignId, 'ask_answered', { ask_id: decodeURIComponent(match[3]), answer: body.answer });
        return send(res, 200, { ok: true });
      }
      const types = { pause: 'paused', resume: 'resumed', stop: 'stopped', add_budget: 'budget_added' };
      cloudEvent(campaignId, types[body.action], body.action === 'add_budget' ? { amount_usd: body.amount_usd } : {});
      return send(res, 200, { ok: true });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({
      events, requests, state, server,
      url: `http://127.0.0.1:${port}/api`,
      answer: (campaignId, askId, answer) => cloudEvent(campaignId, 'ask_answered', { ask_id: askId, answer }),
      close: () => new Promise((done) => server.close(done)),
    });
  }));
}

async function withCloud(fn) {
  const cloud = await fakeCloud();
  const saved = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = cloud.url;
  try {
    return await fn(cloud);
  } finally {
    if (saved === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = saved;
    await cloud.close();
  }
}

// A campaign that has been judged once and is waiting on a person.
function waitingCampaign(store, id = 'cmp-sync') {
  store.append({ campaign_id: id, type: 'campaign_started', actor: 'human:keshav', data: { title: 'Sync it', judge: 'npm test', budget: 10, owner: 'mission-lead' } });
  store.append({ campaign_id: id, type: 'judge_ran', actor: 'judge', data: { passed: false, summary: '1 of 3' } });
  store.append({ campaign_id: id, type: 'ask_opened', actor: 'mission-lead', data: { ask_id: 'a-ship', question: 'Ship to production?' } });
  return id;
}

async function command(store, args, deps = {}) {
  const logs = [];
  const errors = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => logs.push(String(line));
  console.error = (line) => errors.push(String(line));
  try {
    const code = await campaignCommand(args, { store, actor: 'human:keshav', cloud: loggedIn, runJudge: () => ({ passed: false, exit: 1, summary: 'not yet', seconds: 0 }), ...deps });
    return { code, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

test('push sends every local event, campaign_started first, and remembers the link', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  assert.equal(cloudLink(store, id), null);
  const result = await syncCampaign(store, id, loggedIn);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pushed, 3);
  assert.equal(cloud.events[0].type, 'campaign_started');
  assert.deepEqual(cloud.events.map((e) => e.id), store.read(id).map((e) => e.id));
  assert.equal(cloud.requests[0].auth, 'Bearer test-token');
  const link = cloudLink(store, id);
  assert.equal(link.link.url, `${cloud.url}/campaigns/${id}`);
  assert.equal(link.last_seq, 3);
  assert.equal(link.pushed, 3);
}));

test('a phone answer pulled from the cloud unblocks decide', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  await syncCampaign(store, id, loggedIn);
  assert.equal(decide(getCampaign(store, id)).reason, 'open asks');
  cloud.answer(id, 'a-ship', 'yes, ship it');
  const result = await syncCampaign(store, id, loggedIn);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pulled, 1);
  assert.equal(result.pushed, 0);
  const view = getCampaign(store, id);
  assert.deepEqual(view.asks, []);
  assert.equal(decide(view).action, 'propose');
  assert.equal(cloudLink(store, id).pushed, 4);
}));

test('re-sync is idempotent, even after the sync notes are lost', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  cloud.answer(id, 'a-ship', 'yes');
  await syncCampaign(store, id, loggedIn);
  const again = await syncCampaign(store, id, loggedIn);
  assert.deepEqual([again.ok, again.pushed, again.pulled], [true, 0, 0]);
  store.setMeta(`campaign_sync:${id}`, '');
  const fresh = await syncCampaign(store, id, loggedIn);
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.pushed, 0);
  assert.equal(fresh.duplicates, 3);
  assert.equal(fresh.pulled, 0);
  assert.equal(cloud.events.length, 4);
  assert.equal(store.read(id).length, 4);
}));

test('events only a person may send are kept here, never pushed', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  store.append({ campaign_id: id, type: 'ask_answered', actor: 'builder', data: { ask_id: 'a-ship', answer: 'sure' } });
  const result = await syncCampaign(store, id, loggedIn);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.pushed, result.held], [3, 1]);
  assert.ok(!cloud.events.some((e) => e.type === 'ask_answered'));
}));

test('a 403 is reported plainly and not retried', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  cloud.state.refuse = { status: 403, error: 'this campaign belongs to someone else' };
  const result = await syncCampaign(store, id, loggedIn);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'the Atris cloud refused this (403): this campaign belongs to someone else');
  assert.equal(cloud.requests.length, 1);
  const shown = await command(store, ['sync', id]);
  assert.equal(shown.code, 1);
  assert.match(shown.err, /sync failed: the Atris cloud refused this \(403\)/);
}));

test('a different event at the same origin and seq comes back as a plain 409', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  cloud.events.push({ ...store.read(id)[0], id: 'evt-someone-else' });
  const result = await syncCampaign(store, id, loggedIn);
  assert.equal(result.status, 409);
  assert.match(result.error, /holds a different event at the same place \(409\): origin laptop seq 1/);
  assert.equal(cloud.requests.length, 1);
}));

test('not logged in says so without calling the cloud', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  const result = await syncCampaign(store, id, { loadCredentials: () => null });
  assert.equal(result.ok, false);
  assert.match(result.error, /atris login/);
  assert.equal(cloud.requests.length, 0);
}));

test('sync notes live in the sqlite meta table', () => withCloud(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-sync-'));
  try {
    const dbPath = path.join(dir, 'atris.db');
    const store = createSqliteStore(dbPath, { origin: 'laptop' });
    const id = waitingCampaign(store);
    const result = await syncCampaign(store, id, loggedIn);
    assert.equal(result.ok, true, result.error);
    store.close();
    const reopened = createSqliteStore(dbPath);
    assert.equal(cloudLink(reopened, id).last_seq, 3);
    assert.equal(reopened.getMeta('missing-key'), null);
    reopened.setMeta('k', 'one');
    reopened.setMeta('k', 'two');
    assert.equal(reopened.getMeta('k'), 'two');
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('sync --json and start --cloud', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const started = await command(store, ['start', 'Cloud one', '--judge', 'npm test', '--budget', '5', '--id', 'cmp-cloud', '--cloud', '--json']);
  assert.equal(started.code, 0, started.err);
  const startOut = JSON.parse(started.out);
  assert.equal(startOut.cloud.ok, true);
  assert.equal(startOut.cloud.pushed, 2);
  assert.deepEqual(cloud.events.map((e) => e.type), ['campaign_started', 'judge_ran']);
  cloud.answer('cmp-cloud', 'a-none', 'stray');
  const synced = await command(store, ['sync', 'cmp-cloud', '--json']);
  assert.equal(synced.code, 0, synced.err);
  const out = JSON.parse(synced.out);
  assert.deepEqual([out.ok, out.pushed, out.pulled], [true, 0, 1]);
  assert.equal(out.campaign.id, 'cmp-cloud');
}));

test('a person answering on the laptop goes through the cloud for a synced campaign', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  await syncCampaign(store, id, loggedIn);
  const answered = await command(store, ['answer', id, 'a-ship', 'go', '--json']);
  assert.equal(answered.code, 0, answered.err);
  const out = JSON.parse(answered.out);
  assert.equal(out.via, 'cloud');
  assert.deepEqual(out.campaign.asks, []);
  assert.ok(cloud.requests.some((r) => r.path === `/api/campaigns/${id}/asks/a-ship/answer`));
  const local = store.read(id).filter((e) => e.type === 'ask_answered');
  assert.deepEqual(local.map((e) => e.origin), ['cloud']);
}));

// The loop's engine and missions, faked: proposing nothing ends the run.
const quietLoop = { skipReconcile: true, ask: async () => ({ ok: true, text: '[]' }), cli: async () => ({ code: 0, out: '', err: '' }) };

test('run pulls a phone answer before stepping, so the loop gets past the ask', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  await syncCampaign(store, id, loggedIn);
  cloud.answer(id, 'a-ship', 'yes');
  const ran = await command(store, ['run', id, '--json'], { loopDeps: quietLoop });
  assert.equal(ran.code, 0, ran.err);
  const out = JSON.parse(ran.out);
  assert.match(out.reason, /proposed nothing usable/);
  assert.deepEqual(out.sync_warnings, []);
  // The plan that proposed nothing was pushed by the sync after the step.
  assert.ok(cloud.events.some((e) => e.type === 'mission_ended'));
}));

test('run on a synced campaign keeps going offline and warns', async () => {
  const cloud = await fakeCloud();
  const saved = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = cloud.url;
  const store = createMemoryStore({ origin: 'laptop' });
  const id = 'cmp-offline';
  store.append({ campaign_id: id, type: 'campaign_started', actor: 'human:keshav', data: { title: 'Offline', judge: 'npm test', budget: 10, owner: 'mission-lead' } });
  try {
    assert.equal((await syncCampaign(store, id, loggedIn)).ok, true);
    await cloud.close();
    const ran = await command(store, ['run', id], { loopDeps: quietLoop });
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.err, /sync: could not reach the Atris cloud.*running on offline/);
    assert.equal(ran.err.match(/sync:/g).length, 1, 'the same warning is shown once');
    assert.match(ran.out, /judge failed: not yet/);
    assert.match(ran.out, /stopped after 1 step: mission-lead proposed nothing usable/);
  } finally {
    if (saved === undefined) delete process.env.ATRIS_API_URL;
    else process.env.ATRIS_API_URL = saved;
  }
});

test('run stops syncing after a 403 instead of asking every step', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  await syncCampaign(store, id, loggedIn);
  cloud.answer(id, 'a-ship', 'yes');
  await syncCampaign(store, id, loggedIn);
  cloud.state.refuse = { status: 403, error: 'no' };
  const before = cloud.requests.length;
  const ran = await command(store, ['run', id, '--json'], { loopDeps: quietLoop });
  assert.equal(ran.code, 0, ran.err);
  const out = JSON.parse(ran.out);
  assert.deepEqual(out.sync_warnings, ['sync: the Atris cloud refused this (403): no; not syncing again this run']);
  assert.equal(cloud.requests.length - before, 1);
}));

test('a campaign never synced runs without touching the cloud', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  const ran = await command(store, ['run', id, '--json'], { loopDeps: quietLoop });
  assert.equal(ran.code, 0, ran.err);
  assert.match(JSON.parse(ran.out).reason, /needs you/);
  assert.equal(cloud.requests.length, 0);
}));
