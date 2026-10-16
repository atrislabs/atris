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
  const state = { refuse: null, cloudSeq: 0, runs: [] };
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const lastSeq = () => events.length;
  const cloudEvent = (campaignId, type, data) => {
    state.cloudSeq += 1;
    // A second later than now: an answer made in the same millisecond as the
    // ask it answers sorts before it (origin cloud < laptop) and the ask stays open.
    events.push({ id: `evt-cloud-${state.cloudSeq}`, campaign_id: campaignId, type, at: new Date(Date.now() + 1000).toISOString(), origin: 'cloud', seq: state.cloudSeq, actor: 'human:phone', data });
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
      if (!['Bearer test-token', 'Bearer scoped-token'].includes(req.headers.authorization)) return send(res, 401, { ok: false, error: 'sign in first' });
      if (state.refuse) return send(res, state.refuse.status, { ok: false, error: state.refuse.error });
      // The run routes (POST run-in-cloud, GET cloud-run), enough to see what the CLI sends.
      const runMatch = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/(run-in-cloud|cloud-run)$/);
      if (runMatch) {
        const runFor = decodeURIComponent(runMatch[1]);
        if (!events.some((e) => e.campaign_id === runFor)) return send(res, 404, { ok: false, error: `No campaign ${runFor} here.` });
        if (runMatch[2] === 'run-in-cloud' && req.method === 'POST') {
          const body = raw ? JSON.parse(raw) : {};
          state.runs.push(body);
          return send(res, 200, { ok: true, campaign_id: runFor, computer: 'computer:agent-1', run_id: 'a'.repeat(32), status: 'running', woke: false, recorded: true, work: '3000s', break: '600s', max_rounds: body.max_rounds || null, deadline: '2026-10-16T10:00:00Z', check: `/api/campaigns/${runFor}/cloud-run` });
        }
        return send(res, 200, { ok: true, campaign_id: runFor, state: 'running', home: 'computer:agent-1', basis: 'atris_cloud', summary: 'Running on your computer.', run: { run_id: 'a'.repeat(32), computer: 'computer:agent-1', status: 'running', exit_code: null, timed_out: false, output_tail: 'judge failed: 1 of 3\n' } });
      }
      const match = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/(events|asks\/([^/]+)\/answer|actions)$/);
      if (!match) return send(res, 404, { ok: false, error: 'no such route' });
      const campaignId = decodeURIComponent(match[1]);
      const body = raw ? JSON.parse(raw) : {};
      const mine = () => events.filter((e) => e.campaign_id === campaignId);
      if (match[2] === 'events' && req.method === 'GET') {
        // Like the backend: a campaign this login never pushed is not here.
        if (!mine().length) return send(res, 404, { ok: false, error: `No campaign ${campaignId} here.` });
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

test('a phone answer pulled from the cloud closes the ask', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(store);
  await syncCampaign(store, id, loggedIn);
  assert.equal(getCampaign(store, id).state, 'needs_you');
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
  // The wait saved after the empty plan was pushed by the sync after the step.
  assert.ok(cloud.events.some((e) => e.type === 'judge_ran' && e.data.wait));
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
  assert.match(JSON.parse(ran.out).reason, /proposed nothing usable/);
  assert.equal(cloud.requests.length, 0);
}));

// ---------------------------------------------------------------- a computer that never saw it

test('a computer that never saw the campaign pulls it whole, campaign_started first, and stays linked', () => withCloud(async (cloud) => {
  const laptop = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(laptop);
  assert.equal((await syncCampaign(laptop, id, loggedIn)).ok, true);
  cloud.answer(id, 'a-ship', 'yes');
  // The cloud may hold campaign_started anywhere in its log; it must go in first.
  cloud.events.unshift(cloud.events.splice(1, 1)[0]);
  assert.equal(cloud.events[0].type, 'judge_ran');

  const box = createMemoryStore({ origin: 'box' });
  const first = await syncCampaign(box, id, loggedIn);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.first_pull, true);
  assert.deepEqual([first.pulled, first.pushed, first.duplicates], [4, 0, 0]);
  assert.equal(box.read(id)[0].type, 'campaign_started');
  assert.deepEqual(getCampaign(box, id).asks, []);
  assert.equal(getCampaign(box, id).title, 'Sync it');
  assert.ok(cloudLink(box, id), 'linked, so atris campaign run syncs every step');
  assert.equal(cloudLink(box, id).pushed, 4);

  const again = await syncCampaign(box, id, loggedIn);
  assert.deepEqual([again.ok, again.first_pull, again.pulled, again.pushed], [true, undefined, 0, 0]);
  box.append({ campaign_id: id, type: 'paused', actor: 'mission-lead', data: {} });
  const pushed = await syncCampaign(box, id, loggedIn);
  assert.deepEqual([pushed.ok, pushed.pushed], [true, 1]);
  assert.equal(cloud.events[cloud.events.length - 1].origin, 'box');
}));

test('a first pull into the sqlite store lists the campaign and folds it', () => withCloud(async () => {
  const laptop = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(laptop);
  await syncCampaign(laptop, id, loggedIn);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-first-pull-'));
  try {
    const box = createSqliteStore(path.join(dir, 'atris.db'), { origin: 'box' });
    const result = await syncCampaign(box, id, loggedIn);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(box.campaignIds(), [id]);
    assert.deepEqual(getCampaign(box, id), getCampaign(laptop, id));
    box.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('sync of a campaign the cloud does not have says so and leaves nothing behind', () => withCloud(async (cloud) => {
  const box = createMemoryStore({ origin: 'box' });
  const shown = await command(box, ['sync', 'cmp-nope']);
  assert.equal(shown.code, 1);
  assert.match(shown.err, /sync failed: the Atris cloud has no campaign cmp-nope for this login, so there is nothing to pull/);
  assert.equal(cloudLink(box, 'cmp-nope'), null);
  assert.deepEqual(box.read('cmp-nope'), []);
  assert.equal(cloud.requests.length, 1);

  const bad = await command(box, ['sync', 'Not An Id']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /campaign ids look like cmp-/);
  assert.equal(cloud.requests.length, 1);
}));

test('sync --json on a new computer prints the pulled campaign', () => withCloud(async () => {
  const laptop = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(laptop);
  await syncCampaign(laptop, id, loggedIn);
  const box = createMemoryStore({ origin: 'box' });
  const synced = await command(box, ['sync', id, '--json']);
  assert.equal(synced.code, 0, synced.err);
  const out = JSON.parse(synced.out);
  assert.deepEqual([out.ok, out.first_pull, out.pulled], [true, true, 3]);
  assert.equal(out.campaign.id, id);
  assert.deepEqual(out.campaign.asks.map((a) => a.id), ['a-ship']);
}));

test('start --cloud --basis atris_cloud records who pays; the basis needs --cloud and a known value', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const started = await command(store, ['start', 'Cloud paid', '--judge', 'npm test', '--budget', '5', '--id', 'cmp-paid', '--cloud', '--basis', 'atris_cloud', '--json']);
  assert.equal(started.code, 0, started.err);
  assert.equal(store.read('cmp-paid')[0].data.basis, 'atris_cloud');
  assert.equal(cloud.events[0].data.basis, 'atris_cloud');

  const local = await command(store, ['start', 'Not here', '--judge', 'npm test', '--budget', '5', '--id', 'cmp-local', '--basis', 'atris_cloud']);
  assert.equal(local.code, 2);
  assert.match(local.err, /needs --cloud too/);
  const odd = await command(store, ['start', 'Odd', '--judge', 'npm test', '--budget', '5', '--id', 'cmp-odd', '--cloud', '--basis', 'free']);
  assert.equal(odd.code, 2);
  assert.match(odd.err, /--basis is own_engines or atris_cloud/);
  assert.deepEqual(store.read('cmp-local'), []);
  const plain = await command(store, ['start', 'Mine', '--judge', 'npm test', '--budget', '5', '--id', 'cmp-mine']);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(store.read('cmp-mine')[0].data.basis, undefined);
}));

// ---------------------------------------------------------------- cloud-run

test('cloud-run syncs first, asks the cloud to run it, and --status reports the run', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const started = await command(store, ['start', 'Overnight', '--judge', 'npm test', '--budget', '5', '--id', 'cmp-night', '--basis', 'atris_cloud', '--cloud']);
  assert.equal(started.code, 0, started.err);
  store.append({ campaign_id: 'cmp-night', type: 'bet_set', actor: 'human:keshav', data: { bet: 'tests first' } });

  const ran = await command(store, ['cloud-run', 'cmp-night', '--work', '50m', '--break', '10m', '--rounds', '3']);
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /running cmp-night on your Atris computer \(computer:agent-1\), run a{32}/);
  assert.match(ran.out, /3 rounds/);
  assert.match(ran.out, /atris campaign cloud-run cmp-night --status/);
  assert.deepEqual(cloud.state.runs, [{ work: '50m', break: '10m', max_rounds: 3 }]);
  assert.ok(cloud.events.some((e) => e.type === 'bet_set'), 'the newest local event reached the cloud before the run');
  const order = cloud.requests.map((r) => `${r.method} ${r.path}`);
  assert.ok(order.indexOf('POST /api/campaigns/cmp-night/run-in-cloud') > order.lastIndexOf('POST /api/campaigns/cmp-night/events'));

  const status = await command(store, ['cloud-run', 'cmp-night', '--status', '--json']);
  assert.equal(status.code, 0, status.err);
  const out = JSON.parse(status.out);
  assert.deepEqual([out.run.status, out.home], ['running', 'computer:agent-1']);
  const human = await command(store, ['cloud-run', 'cmp-night', '--status']);
  assert.match(human.out, /run a{32} on computer:agent-1: running/);
  assert.match(human.out, /last output:\njudge failed: 1 of 3/);
}));

test('cloud-run works for a campaign that lives only in the cloud', () => withCloud(async (cloud) => {
  const laptop = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(laptop);
  await syncCampaign(laptop, id, loggedIn);
  const phone = createMemoryStore({ origin: 'other' });
  const ran = await command(phone, ['cloud-run', id, '--json']);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(JSON.parse(ran.out).run_id, 'a'.repeat(32));
  assert.deepEqual(cloud.state.runs, [{}]);
  assert.deepEqual(phone.read(id), []);
}));

test('cloud-run checks its flags before calling the cloud', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  for (const [args, words] of [
    [['--work', 'fast'], /durations look like 50m/],
    [['--break', '10 minutes'], /durations look like 50m/],
    [['--rounds', '0'], /--rounds is a whole number/],
    [['--rounds', '2.5'], /--rounds is a whole number/],
  ]) {
    const shown = await command(store, ['cloud-run', 'cmp-x', ...args]);
    assert.equal(shown.code, 2, shown.out);
    assert.match(shown.err, words);
  }
  assert.equal((await command(store, ['cloud-run'])).code, 2);
  assert.equal(cloud.requests.length, 0);
}));

test('cloud-run passes the cloud refusal on in its own words', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const missing = await command(store, ['cloud-run', 'cmp-ghost']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /not started in the cloud: No campaign cmp-ghost here\./);

  const id = waitingCampaign(store);
  await syncCampaign(store, id, loggedIn);
  cloud.state.refuse = { status: 403, error: `Campaign ${id} runs on your own engines, so it stays on your machines.` };
  const refused = await command(store, ['cloud-run', id]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /sync failed: the Atris cloud refused this \(403\)/);

  cloud.state.refuse = null;
  const runRefusal = { status: 403, error: 'Only a campaign started with --basis atris_cloud runs on your Atris computer.' };
  const send = await runInCloudOnly(store, id, runRefusal);
  assert.match(send.error, /Only a campaign started with --basis atris_cloud/);
  assert.equal(send.status, 403);

  const old = await runInCloudOnly(store, id, { status: 404 });
  assert.match(old.error, /does not run campaigns on computers yet \(404\)/);
}));

// runInCloud against a fixed answer, for the refusal wording.
async function runInCloudOnly(store, id, answer) {
  const { runInCloud } = require('../lib/campaign-sync');
  return runInCloud(id, {}, {
    loadCredentials: () => ({ token: 'test-token' }),
    apiRequestJson: async () => ({ ok: false, status: answer.status, data: answer.error ? { ok: false, error: answer.error } : { detail: 'Not Found' }, error: answer.error || 'Not Found' }),
  });
}

test('cloud-run without a login says so without calling the cloud', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'laptop' });
  const shown = await command(store, ['cloud-run', 'cmp-x'], { cloud: { loadCredentials: () => null } });
  assert.equal(shown.code, 1);
  assert.match(shown.err, /atris login/);
  assert.equal(cloud.requests.length, 0);
}));

// ---------------------------------------------------------------- the campaign token on a cloud computer

function tokenFile(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-token-'));
  const file = path.join(dir, 'cmp.token');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 });
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a cloud computer syncs with the campaign token from its file, never the login', () => withCloud(async (cloud) => {
  const laptop = createMemoryStore({ origin: 'laptop' });
  const id = waitingCampaign(laptop);
  await syncCampaign(laptop, id, loggedIn);
  const placed = tokenFile({ campaign_id: id, token: 'scoped-token', expires_at: 9999999999 });
  try {
    const env = { ATRIS_CAMPAIGN_TOKEN_FILE: placed.file, OTHER: '1' };
    const box = createMemoryStore({ origin: 'box' });
    const before = cloud.requests.length;
    const shown = await command(box, ['sync', id, '--json'], { env });
    assert.equal(shown.code, 0, shown.err);
    assert.equal(JSON.parse(shown.out).first_pull, true);
    assert.deepEqual(env, { OTHER: '1' }, 'the path is taken out of the environment');
    const used = cloud.requests.slice(before).map((r) => r.auth);
    assert.ok(used.length > 0 && used.every((auth) => auth === 'Bearer scoped-token'));
  } finally {
    placed.done();
  }
}));

test('a campaign token never falls back to the login, and only serves its own campaign', () => withCloud(async (cloud) => {
  const store = createMemoryStore({ origin: 'box' });
  const id = waitingCampaign(store);
  const wrong = await syncCampaign(store, id, { ...loggedIn, campaignToken: { campaign_id: 'cmp-other', token: 'scoped-token' } });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /the campaign token here is for cmp-other, not cmp-sync/);
  const broken = tokenFile('not json');
  try {
    const env = { ATRIS_CAMPAIGN_TOKEN_FILE: broken.file };
    const shown = await command(store, ['sync', id], { env });
    assert.equal(shown.code, 1);
    assert.match(shown.err, /campaign token file .* could not be read/);
    assert.equal(env.ATRIS_CAMPAIGN_TOKEN_FILE, undefined);
  } finally {
    broken.done();
  }
  assert.equal(cloud.requests.length, 0, 'nothing went out with the login instead');
}));

test('the token path never reaches a child process', async () => {
  const placed = tokenFile({ campaign_id: 'cmp-sync', token: 'scoped-token' });
  const saved = process.env.ATRIS_CAMPAIGN_TOKEN_FILE;
  process.env.ATRIS_CAMPAIGN_TOKEN_FILE = placed.file;
  try {
    const shown = await command(createMemoryStore({ origin: 'box' }), ['features', '--json']);
    assert.equal(shown.code, 0, shown.err);
    assert.equal(process.env.ATRIS_CAMPAIGN_TOKEN_FILE, undefined);
    const child = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.ATRIS_CAMPAIGN_TOKEN_FILE))']);
    assert.equal(child.stdout.toString(), 'undefined');
  } finally {
    if (saved === undefined) delete process.env.ATRIS_CAMPAIGN_TOKEN_FILE;
    else process.env.ATRIS_CAMPAIGN_TOKEN_FILE = saved;
    placed.done();
  }
});

test('features says what the backend checks before a cloud run', async () => {
  const shown = await command(createMemoryStore({ origin: 'box' }), ['features', '--json']);
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(JSON.parse(shown.out), { ok: true, features: ['cloud_pull', 'campaign_token_file'] });
});
