'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const phone = require('../lib/gm-phone');
const { phonePage } = require('../lib/gm-phone-page');

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();

function review(i, member = 'builder', age = '7d') {
  return { task_id: `T${i}`, ref: `CLI-${100 + i}`, title: `job ${i}`, member, age };
}

function view(over = {}) {
  return {
    workspace_name: 'shop',
    target: null,
    target_default: { landed: 19, max_abandoned: 2, max_stuck: 0 },
    landed_this_week: 0,
    roster: [
      { name: 'builder', status: 'on a job' },
      { name: 'auto-improver', status: 'stuck 9h' },
      { name: 'validator', status: 'idle' },
    ],
    last_plays: [{ member: 'builder', play: 'landed', title: 'fix the login', at: NOW - 2 * HOUR }],
    reviews: Array.from({ length: 22 }, (_, i) => review(i)),
    stuck: [
      { task_id: 'S1', ref: 'CLI-1', title: 'a', member: 'builder', age: '2d' },
      { task_id: 'S2', ref: 'CLI-2', title: 'b', member: 'builder', age: '1d' },
      { task_id: 'S3', ref: 'CLI-3', title: 'c', member: 'executor', age: '9h' },
      { task_id: 'S4', ref: 'CLI-4', title: 'd', member: 'executor', age: '7h' },
    ],
    outcomes: [],
    policy: { authorized: true, accept_all: false, strict_verify: true },
    error: null,
    ...over,
  };
}

const tally = (outcomes) => {
  const out = { landed: 0, dropped: 0, sent_back: 0, abandoned: 0 };
  for (const o of outcomes) if (o.kind in out) out[o.kind] += 1;
  return out;
};

// ---- cards ------------------------------------------------------------------------

test('cards rank by how much they move the target; the missing target leads', () => {
  assert.deepEqual(phone.buildCards(view()).map(c => c.id), ['target', 'review', 'stuck']);
  const withTarget = view({ target: { landed: 0, target: { landed: 19 }, verdict: 'behind' } });
  assert.deepEqual(phone.buildCards(withTarget).map(c => c.id), ['review', 'stuck']);
  // autoland off: no reviewer pass, so the review card only moves the oldest 3
  const off = view({ target: withTarget.target, policy: { authorized: false } });
  assert.deepEqual(phone.buildCards(off).map(c => c.id), ['stuck', 'review']);
});

test('review card: real numbers and the reviewer pass as the big button', () => {
  const card = phone.buildCards(view()).find(c => c.id === 'review');
  assert.equal(card.text, '22 jobs are waiting on review. the oldest has waited 7d.');
  assert.deepEqual(card.choices.map(c => c.id), ['check', 'oldest', 'later']);
  const check = card.choices[0];
  assert.equal(check.effect, 'up to +12 toward your target');
  assert.equal(check.confirm, true);
  assert.equal(check.ack, 'reviewer: on it, checking 22 jobs');
  assert.deepEqual(check.steps, [['task', 'auto-accept-certified', '--json', '--certify-first']]);
  assert.equal(card.jobs.length, 3);
  assert.deepEqual(card.jobs[0], { ref: 'CLI-100', task_id: 'T0', title: 'job 0', member: 'builder', age: '7d' });

  const all = phone.buildCards(view({ policy: { authorized: true, accept_all: true } })).find(c => c.id === 'review');
  assert.equal(all.choices[0].effect, 'up to +22 toward your target');
  assert.deepEqual(all.choices[0].steps[0].slice(-1), ['--all']);

  const loose = phone.reviewerCommand({ authorized: true, strict_verify: false });
  assert.deepEqual(loose.slice(-1), ['--no-strict-verify']);
});

test('review card with autoland off offers only the oldest 3 and later', () => {
  const card = phone.buildCards(view({ policy: { authorized: false } })).find(c => c.id === 'review');
  assert.deepEqual(card.choices.map(c => c.id), ['oldest', 'later']);
  assert.equal(phone.reviewerCommand({ authorized: false }), null);
});

test('stuck card frees each claim as its holder or wakes each holder once', () => {
  const card = phone.buildCards(view()).find(c => c.id === 'stuck');
  assert.equal(card.text, '4 jobs are stuck with builder and executor. nothing moved on them for 6h or more, the oldest 2d.');
  const [free, nudge, later] = card.choices;
  assert.equal(free.label, 'free the 4 so others can take them');
  assert.equal(free.effect, '4 jobs back in the queue, counts as 4 drops');
  assert.deepEqual(free.steps, [
    ['task', 'release', 'CLI-1', '--as', 'builder'],
    ['task', 'release', 'CLI-2', '--as', 'builder'],
    ['task', 'release', 'CLI-3', '--as', 'executor'],
    ['task', 'release', 'CLI-4', '--as', 'executor'],
  ]);
  assert.deepEqual(nudge.steps, [['member', 'wake', 'builder'], ['member', 'wake', 'executor']]);
  assert.equal(free.confirm && nudge.confirm, true);
  assert.equal(later.id, 'later');
});

test('a holder name that could be a flag or a path never reaches a command', () => {
  const stuck = [{ task_id: 'S9', ref: 'CLI-9', title: 'x', member: '--all; rm', age: '2d' }];
  assert.equal(phone.buildCards(view({ stuck, reviews: [] })).find(c => c.id === 'stuck'), undefined);
});

test('target card: suggested default, a lower one, no confirm, local only', () => {
  const card = phone.buildCards(view()).find(c => c.id === 'target');
  assert.equal(card.text, 'no target set for this week. over the last 4 weeks you landed about 19 a week.');
  const [set, lower, later] = card.choices;
  assert.equal(set.label, "set this week's target: 19");
  assert.deepEqual(set.target, { landed: 19, max_abandoned: 2, max_stuck: 0 });
  assert.equal(lower.label, 'set a lower one: 10');
  assert.equal(set.local && lower.local, true);
  assert.equal(Boolean(set.confirm || lower.confirm), false);
  assert.equal(later.id, 'later');
  const one = phone.buildCards(view({ target_default: { landed: 1, max_abandoned: 2, max_stuck: 0 } })).find(c => c.id === 'target');
  assert.deepEqual(one.choices.map(c => c.id), ['set', 'later']);
});

test('job buttons map to the real accept and revise commands', () => {
  const cards = phone.buildCards(view());
  const approve = phone.resolveChoice(cards, 'review', 'approve:CLI-100');
  assert.deepEqual(approve.choice.steps, [['task', 'accept', 'CLI-100']]);
  assert.equal(approve.choice.confirm, true);
  const back = phone.resolveChoice(cards, 'review', 'sendback:CLI-101');
  assert.deepEqual(back.choice.steps, [['task', 'revise', 'CLI-101', '--note', phone.SEND_BACK_NOTE]]);
  // only the three jobs on screen can be acted on
  assert.equal(phone.resolveChoice(cards, 'review', 'approve:CLI-120'), null);
  assert.equal(phone.resolveChoice(cards, 'stuck', 'approve:CLI-1'), null);
});

test('the page gets words and commands to show, never anything to run', () => {
  const card = phone.publicCard(phone.buildCards(view()).find(c => c.id === 'stuck'));
  assert.equal(card.choices[0].commands[0], 'atris task release CLI-1 --as builder');
  assert.equal('steps' in card.choices[0], false);
});

test('session: at most five decisions, snoozed cards drop out', () => {
  const cards = phone.buildCards(view());
  assert.equal(phone.sessionCards(cards, { decided: 0, snoozed: new Set() }).length, 3);
  assert.deepEqual(phone.sessionCards(cards, { decided: 1, snoozed: new Set(['target']) }).map(c => c.id), ['review', 'stuck']);
  assert.deepEqual(phone.sessionCards(cards, { decided: 5, snoozed: new Set() }), []);
});

test('strip, team circles, and the live line', () => {
  assert.equal(phone.targetStrip(view()).line, '0 landed this week, no target yet');
  assert.equal(phone.targetStrip(view({ target: { landed: 3, target: { landed: 19 }, verdict: 'behind' } })).line, '3 of 19 landed, behind');
  assert.equal(phone.initials('auto-improver'), 'ai');
  assert.equal(phone.initials('builder'), 'bu');
  assert.equal(phone.tone('stuck 9h'), 'stuck');
  assert.equal(phone.tone('waiting on review 2d'), 'waiting');
  assert.equal(phone.tone('on a job'), 'working');
  assert.equal(phone.liveLine(view(), NOW), 'builder landed "fix the login" 2h ago');
});

test('outcome line: exit code first, then task events since the tap', () => {
  const action = { member: 'reviewer', status: 'done', exit_code: 0, started_at: NOW, ack: 'x' };
  const outcomes = [{ kind: 'landed', at: NOW + 1 }, { kind: 'landed', at: NOW + 2 }, { kind: 'sent_back', at: NOW + 3 }, { kind: 'landed', at: NOW - 1 }];
  assert.equal(phone.actionOutcome(action, outcomes, { tally }), 'reviewer: done. since you tapped: 2 landed, 1 sent back');
  assert.equal(phone.actionOutcome({ ...action, exit_code: 2, last_line: 'proof required' }, [], { tally }),
    'reviewer: did not finish, exit code 2 (proof required). no task events since you tapped');
  assert.equal(phone.actionOutcome({ ...action, status: 'running' }, [], { tally }), 'x');
});

// ---- requests ------------------------------------------------------------------

const TOKEN = 'k'.repeat(43);

function req(method, url, headers = {}) {
  return { method, url, headers: { host: '127.0.0.1:7777', ...headers } };
}

test('token check: 403 without it, with a wrong one, or on a strange host', () => {
  const opts = { token: TOKEN, hosts: ['127.0.0.1:7777'] };
  assert.equal(phone.checkRequest(req('GET', '/'), opts).status, 403);
  assert.equal(phone.checkRequest(req('GET', `/?t=${'j'.repeat(43)}`), opts).status, 403);
  assert.equal(phone.checkRequest(req('GET', '/?t=short'), opts).status, 403);
  assert.equal(phone.checkRequest(req('GET', `/?t=${TOKEN}`), opts).ok, true);
  assert.equal(phone.checkRequest(req('GET', `/state?t=${TOKEN}`, { host: 'evil.example:7777' }), opts).status, 403);
  assert.equal(phone.tokenMatches('', ''), false);
  assert.equal(phone.checkRequest(req('GET', '/state', { 'x-gm-token': TOKEN, 'content-length': '5000' }), opts).status, 400);
});

test('POST needs the token in a header and the same origin', () => {
  const opts = { token: TOKEN, hosts: ['127.0.0.1:7777'] };
  const origin = { origin: 'http://127.0.0.1:7777' };
  assert.equal(phone.checkRequest(req('POST', `/action?t=${TOKEN}`, origin), opts).status, 403, 'token in the link is not enough');
  assert.equal(phone.checkRequest(req('POST', '/action', { 'x-gm-token': TOKEN }), opts).status, 403, 'no origin');
  assert.equal(phone.checkRequest(req('POST', '/action', { 'x-gm-token': TOKEN, origin: 'http://evil.example' }), opts).status, 403);
  assert.equal(phone.checkRequest(req('POST', '/action', { 'x-gm-token': TOKEN, ...origin }), opts).ok, true);
  assert.equal(phone.checkRequest(req('PUT', `/?t=${TOKEN}`), opts).status, 405);
  assert.equal(phone.checkRequest(req('PUT', '/'), opts).status, 403);
});

test('malformed phone URLs are rejected before checking credentials', () => {
  const opts = { token: TOKEN, hosts: ['127.0.0.1:7777'] };
  for (const target of ['//x:99999', 'http://x:99999/', '/%ZZ', '/%00']) {
    assert.equal(phone.checkRequest(req('GET', target), opts).status, 400);
  }
});

// ---- the handler over real http with a stubbed runner -------------------------------

async function startHandler(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-test-'));
  const ran = [];
  let clock = NOW;
  let current = over.view || view();
  const writes = [];
  let restored = 0;
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: '/tmp/shop',
    token: over.token || TOKEN,
    hosts,
    tally,
    now: () => clock,
    loadView: () => current,
    runStep: over.runStep || (async (args) => { ran.push(args); return { code: 0, last_line: 'ok' }; }),
    writeTarget: (target) => { writes.push(target); return true; },
    snapshotTarget: () => () => { restored += 1; return true; },
    logPath: path.join(dir, 'gm-phone-actions.jsonl'),
    page: phonePage,
    ...(over.makeBetDesk ? { makeBetDesk: log => over.makeBetDesk(log, dir) } : {}),
  });
  const server = http.createServer((q, s) => {
    handler(q, s).catch(() => { s.writeHead(500); s.end(); });
  });
  const address = over.listenAddress || '127.0.0.1';
  await new Promise(resolve => server.listen(0, address, resolve));
  const base = `${address}:${server.address().port}`;
  hosts.push(base);
  const call = async (method, p, { body, token = TOKEN, header = true, origin = `http://${base}`, headers: more = {} } = {}) => {
    const headers = { ...more };
    if (header && token) headers['x-gm-token'] = token;
    if (origin) headers.origin = origin;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(`http://${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json, headers: res.headers };
  };
  return {
    base,
    handler,
    call,
    ran,
    writes,
    get restored() { return restored; },
    setView: (v) => { current = v; },
    tick: (ms) => { clock += ms; },
    logPath: path.join(dir, 'gm-phone-actions.jsonl'),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}

test('over http: malformed phone requests return 4xx and leave the session alive', async () => {
  const h = await startHandler();
  const raw = (target, body) => new Promise((resolve, reject) => {
    const q = http.request(`http://${h.base}`, {
      method: body === undefined ? 'GET' : 'POST',
      path: target,
      headers: body === undefined ? {} : {
        'x-gm-token': TOKEN, origin: `http://${h.base}`, 'content-type': 'application/json',
      },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.on('error', reject);
    q.end(body);
  });
  try {
    for (const target of ['//x:99999', 'http://x:99999/', '/%ZZ', '/%00']) {
      assert.equal(await raw(target), 400);
    }
    for (const body of ['{', 'null', '[]', '"x"']) assert.equal(await raw('/action', body), 400);
    assert.equal(await raw('/action', JSON.stringify({ padding: 'x'.repeat(5000) })), 413);
    assert.equal((await h.call('GET', '/state')).status, 200);
    assert.equal((await h.call('GET', '/state?label=%23%5C')).status, 200);
    assert.equal(h.ran.length, 0);
    assert.equal(h.writes.length, 0);
  } finally { await h.close(); }
});

test('over http: the paired link and authenticated actions work on the wifi address', async t => {
  const address = phone.lanAddress();
  if (!address) return t.skip('no network interface available');
  const h = await startHandler({ listenAddress: address });
  try {
    assert.equal((await h.call('GET', `/?t=${TOKEN}`, { header: false })).status, 200);
    assert.equal((await h.call('POST', '/action', { header: false, body: { card: 'target', choice: 'later' } })).status, 403);
    assert.equal((await h.call('POST', '/action', { body: { card: 'target', choice: 'later' } })).status, 200);
  } finally { await h.close(); }
});

test('over http: 403 without the token, the page and state with it', async () => {
  const h = await startHandler();
  try {
    assert.equal((await h.call('GET', '/', { header: false })).status, 403);
    assert.equal((await h.call('GET', '/state', { token: 'nope' })).status, 403);
    assert.equal((await h.call('GET', `/state?t=${'x'.repeat(43)}`, { header: false })).status, 403);
    const page = await h.call('GET', `/?t=${TOKEN}`, { header: false });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>front office<\/title>/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const state = await h.call('GET', '/state');
    assert.equal(state.status, 200);
    assert.equal(state.json.card.id, 'target');
    assert.equal(state.json.strip.line, '0 landed this week, no target yet');
    assert.deepEqual(state.json.team.map(t => t.initials), ['bu', 'ai', 'va']);
    const noHeader = await h.call('POST', `/action?t=${TOKEN}`, { header: false, body: { card: 'target', choice: 'later' } });
    assert.equal(noHeader.status, 403);
    const crossSite = await h.call('POST', '/action', { origin: 'http://evil.example', body: { card: 'target', choice: 'later' } });
    assert.equal(crossSite.status, 403);
    assert.equal(h.ran.length, 0);
  } finally {
    await h.close();
  }
});

test('over http: confirm-required actions refuse a single tap, then run and log', async () => {
  const h = await startHandler();
  try {
    const once = await h.call('POST', '/action', { body: { card: 'stuck', choice: 'free' } });
    assert.equal(once.status, 409);
    assert.equal(once.json.reason, 'needs_confirm');
    assert.equal(h.ran.length, 0);

    const twice = await h.call('POST', '/action', { body: { card: 'stuck', choice: 'free', confirm: true } });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.ack, 'front office: freeing 4 jobs');
    await Promise.all(h.handler.actions.map(a => a.done));
    assert.deepEqual(h.ran, [
      ['task', 'release', 'CLI-1', '--as', 'builder'],
      ['task', 'release', 'CLI-2', '--as', 'builder'],
      ['task', 'release', 'CLI-3', '--as', 'executor'],
      ['task', 'release', 'CLI-4', '--as', 'executor'],
    ]);
    const log = fs.readFileSync(h.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(log.length, 4);
    assert.deepEqual(Object.keys(log[0]).sort(), ['at', 'card', 'choice', 'command', 'exit_code', 'workspace']);
    assert.equal(log[0].command, 'atris task release CLI-1 --as builder');
    assert.equal(log[0].exit_code, 0);
    assert.equal(log[0].workspace, '/tmp/shop');

    const state = await h.call('GET', '/state');
    assert.equal(state.json.actions[0].status, 'done');
    assert.equal(state.json.actions[0].line, 'front office: done. no task events since you tapped');
    // the stuck card is decided for this session
    assert.equal(state.json.decided, 1);
    assert.ok(!['stuck'].includes(state.json.card.id));

    // a card the page thinks exists but the server no longer offers
    const stale = await h.call('POST', '/action', { body: { card: 'stuck', choice: 'nudge', confirm: true } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.reason, 'gone');
  } finally {
    await h.close();
  }
});

test('over http: a failing command reports its exit code and last line', async () => {
  const h = await startHandler({ runStep: async () => ({ code: 3, last_line: 'proof required' }) });
  try {
    await h.call('POST', '/action', { body: { card: 'review', choice: 'approve:CLI-100', confirm: true } });
    await Promise.all(h.handler.actions.map(a => a.done));
    const state = await h.call('GET', '/state');
    assert.equal(state.json.actions[0].status, 'failed');
    assert.equal(state.json.actions[0].exit_code, 3);
    assert.match(state.json.actions[0].line, /^builder: did not finish, exit code 3 \(proof required\)/);
    // approving one job keeps the review card on screen
    assert.equal(state.json.decided, 0);
  } finally {
    await h.close();
  }
});

test('over http: target applies at once and undoes within the window', async () => {
  const h = await startHandler();
  try {
    const set = await h.call('POST', '/action', { body: { card: 'target', choice: 'set' } });
    assert.equal(set.status, 200);
    assert.deepEqual(h.writes, [{ landed: 19, max_abandoned: 2, max_stuck: 0 }]);
    assert.equal(set.json.undo.ms, phone.UNDO_MS);
    let state = await h.call('GET', '/state');
    assert.equal(state.json.undo.id, set.json.id);
    assert.equal(state.json.card.id, 'review');

    const undone = await h.call('POST', '/undo', { body: { id: set.json.id } });
    assert.equal(undone.status, 200);
    assert.equal(h.restored, 1);
    state = await h.call('GET', '/state');
    assert.equal(state.json.card.id, 'target');
    assert.equal(state.json.decided, 0);

    const again = await h.call('POST', '/action', { body: { card: 'target', choice: 'lower' } });
    assert.deepEqual(h.writes[1], { landed: 10, max_abandoned: 2, max_stuck: 0 });
    h.tick(phone.UNDO_MS + 5000);
    const late = await h.call('POST', '/undo', { body: { id: again.json.id } });
    assert.equal(late.status, 409);
    assert.equal(h.restored, 1);
    const log = fs.readFileSync(h.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(log[0].command, 'atris gm target --landed 19 --max-abandoned 2 --max-stuck 0');
    assert.equal(log[1].choice, 'undo');
  } finally {
    await h.close();
  }
});

test('over http: all clear after five decisions, naming what still runs', async () => {
  const h = await startHandler();
  try {
    for (const card of ['target', 'review', 'stuck']) {
      const res = await h.call('POST', '/action', { body: { card, choice: 'later' } });
      assert.equal(res.status, 200);
    }
    let state = await h.call('GET', '/state');
    assert.equal(state.json.card, null);
    assert.deepEqual(state.json.all_clear.still_running, ['builder is on a job']);
    // nothing to decide at all is also all clear
    h.setView(view({ target: { landed: 2, target: { landed: 19 }, verdict: 'behind' }, reviews: [], stuck: [], roster: [] }));
    state = await h.call('GET', '/state');
    assert.equal(state.json.card, null);
    assert.deepEqual(state.json.all_clear.still_running, []);
  } finally {
    await h.close();
  }
  const limit = phone.sessionCards(phone.buildCards(view()), { decided: phone.CARD_LIMIT, snoozed: new Set() });
  assert.deepEqual(limit, []);
});

test('over http: an empty queue tap gets a question card at once; its answer goes to /act with the card id', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  let ledgerFile = null;
  // a writer that never finishes: the tap must not wait on it
  const calls = [];
  const h = await startHandler({
    makeBetDesk: (log, dir) => {
      ledgerFile = path.join(dir, 'gm-bets.jsonl');
      // the writer reads the installs, then never finishes
      return gmBet.createBetDesk({ workspaceRoot: root, ledgerFile, now: () => NOW, log, generate: (opts) => { calls.push(opts); opts.onBundle({ sources: { installs: { data: { last_week: 1511, week_before: 1640 } } } }); return new Promise(() => {}); }, generateQuestion: () => new Promise(() => {}), runCli: async () => ({ code: 0, stdout: '{}' }) });
    },
  });
  const post = (body, over = {}) => h.call('POST', '/act', { body, ...over });
  try {
    assert.equal(calls.length, 1, 'the desk warms as soon as the server makes it');
    const started = Date.now();
    const tap = await post({ orb: true });
    assert.ok(Date.now() - started < 1000);
    assert.equal(tap.status, 200);
    const q = tap.json.card;
    assert.equal(q.kind, 'question');
    assert.equal(q.options.length, 3);
    // two parts: the question, and what is going on with why the answer matters
    assert.equal(q.title, 'what matters most for this project this month?');
    assert.equal(q.body, 'installs dropped to 1,511 last week, down from 1,640.');
    // same token, origin, and json checks as every other post
    assert.equal((await post({ card_id: q.id, option_id: 'money' }, { token: 'nope' })).status, 403);
    assert.equal((await post({ card_id: q.id, option_id: 'money' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ card_id: q.id, option_id: 'nope' })).json.reason, 'bad_option');
    const answered = await post({ card_id: q.id, option_id: 'money' });
    assert.equal(answered.status, 200);
    assert.notEqual(answered.json.card.id, q.id, 'the answer is the next card');
    assert.equal(gmBet.readFocus(gmBet.focusPath(path.dirname(ledgerFile)), root).focus.label, 'making money from it');
    assert.equal((await post({ card_id: q.id, option_id: 'money' })).json.reason, 'gone', 'that card is gone now');
    assert.equal(calls.length, 1, 'still the one generation in the background');
  } finally {
    await h.close();
  }
});

test('over http: a choice card picks through /act with the same checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const titles = ['Write a getting started page for the phone', 'Record a two minute demo video for the readme'];
  let n = 0;
  const bet = title => ({ title, why_now: 'installs last week were 1,400.', expect: 'more people try it by nov 1.', target: { metric: 'installs', baseline: 1400, goal: 1700 }, metric_source: 'npm', verify: 'test -s docs/a.md', cost: 'about 2 hours', check_date: '2026-10-30', steps: [{ text: 'draft it', who: 'team', member: 'builder', public: false }, { text: 'publish it', who: 'you', public: true }] });
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, readTeam: () => null, generate: () => Promise.resolve(n < 2 ? { ok: true, bet: bet(titles[n++]) } : new Promise(() => {})), generateQuestion: () => new Promise(() => {}), runCli: async () => ({ code: 0, stdout: '{}' }) }),
  });
  const post = (body, over = {}) => h.call('POST', '/act', { body, ...over });
  try {
    await new Promise(r => setTimeout(r, 30));
    const c = (await post({ orb: true })).json.card;
    assert.equal(c.kind, 'choice');
    assert.deepEqual(c.options.map(o => o.label), titles);
    assert.equal((await post({ card_id: c.id, option_id: c.options[0].id }, { token: 'nope' })).status, 403);
    const picked = await post({ card_id: c.id, option_id: c.options[0].id });
    assert.deepEqual([picked.status, picked.json.card.kind, picked.json.card.title], [200, 'idea', titles[0]]);
    assert.equal((await post({ card_id: c.id, option_id: c.options[1].id })).status, 409, 'the choice is gone once one is picked');
  } finally {
    await h.close();
  }
});

test('page: one renderer: draw(card) is the only place a card is drawn, and every button on it is one of the card\'s own options', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
  // one draw for every kind; the old draws, one per kind, are gone
  assert.equal((script.match(/function draw\(card\)/g) || []).length, 1);
  for (const gone of ['drawBetCard', 'drawJobCard', 'drawQuestionCard', 'drawChoiceCard', 'drawReportCard', 'drawReply', 'drawTeam', 'drawEngine', 'drawTalk', 'drawDeck', 'fillDeckCard', 'sayBox', 'convo(', 'yesPill', 'moveOn', '/bet/']) {
    assert.ok(!script.replace("api('/bet')", '').includes(gone), gone);
  }
  // a draw starts from nothing, so nothing from the card before survives it
  assert.match(script, /function draw\(card\) \{\n\s+var b = box\(\);\n\s+b\.textContent = '';/);
  // the buttons come only from the card's options and its box
  assert.match(script, /var rest = card\.options\.filter\(function \(o\) \{ return !o\.cell; \}\);\n\s+var quiet = function \(o\) \{ return !o\.style \|\| o\.style === 'quiet'; \};/);
  assert.match(script, /if \(card\.input\) b\.appendChild\(inputLine\(card\.input\)\);/);
  // an idea in a choice: a big title and one plain line of why
  assert.match(script, /btn\.appendChild\(el\('span', 't', o\.label\)\);\n\s+if \(o\.detail\) btn\.appendChild\(el\('span', 'w', o\.detail\)\);/);
  assert.match(html, /\.option \.t \{[^}]*font-size: 20px;/);
  assert.match(html, /\.option \.w \{[^}]*font-size: 17px;/);
  // every act names the card on screen and one option on it, to one route
  assert.match(script, /body\.card_id = from\.id;/);
  assert.match(script, /send\(btn, \{ option_id: o\.id \}, o\);/);
  assert.match(script, /var answer = api\('\/act', body\)\.catch\(offline\);/);
});

test('page: the team is a card: the footer asks the Mac for it, its table comes from the card, and a member and an engine are options in their cells', () => {
  const gmCard = require('../lib/gm-card');
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the footer opens the team or the job deck as the next card, from any card or the big orb
  assert.match(script, /getElementById\('working'\)\.addEventListener\('click', function \(\) \{ openFrom\('team'\); \}\);/);
  assert.match(script, /getElementById\('needs'\)\.addEventListener\('click', function \(\) \{ openFrom\('deck'\); \}\);/);
  assert.match(script, /api\('\/act', \{ open: which, card_id: bet\.shown \? bet\.shown\.id : null \}\)/);
  assert.doesNotMatch(html, /id="team"/);
  // the table: a header cell for each column the card names, each cell as text
  assert.match(script, /t\.columns\.forEach\(function \(c\) \{ head\.appendChild\(el\('th', c, c\)\)\.scope = 'col'; \}\);/);
  assert.match(script, /\} else td\.textContent = cell;/);
  // an option with a cell is drawn in that cell; a tap anywhere on its row is the row's first option
  assert.match(script, /var o = mine\.filter\(function \(x\) \{ return x\.cell\.column === col; \}\)\[0\];/);
  assert.match(script, /tr\.addEventListener\('click', function \(\) \{ var first = tr\.querySelector\('button'\); if \(first\) first\.click\(\); \}\);/);
  // the team card itself: five columns, a member button and an engine button per row
  // (a person has no engine to swap), and a way back
  const team = gmCard.team({ id: 'team~1', rows: [{ member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'working', sentence: 'working: the try page' }, { member: 'sam', role: 'owner', ovr: '..', engine: 'person', status: 'idle', sentence: 'idle' }] });
  assert.deepEqual(team.table.columns, ['member', 'role', 'ovr', 'engine', 'status']);
  assert.deepEqual(team.options.map(o => [o.id, o.cell ? o.cell.column : null]), [['talk:builder', 'member'], ['swap:builder', 'engine'], ['talk:sam', 'member'], ['back', null]]);
  assert.deepEqual(gmCard.cardProblems(team), []);
});

test('page: the team table is divided, keeps its columns apart at phone width, and scrolls sideways instead of squashing', () => {
  const html = phonePage('NONCE');
  const rule = sel => {
    const m = new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(html);
    assert.ok(m, `no rule for ${sel}`);
    return m[1];
  };
  // the box scrolls sideways; the table never gets narrower than its columns need
  assert.match(rule('.grid'), /overflow-x: auto;/);
  assert.match(rule('.grid'), /border: 1px solid var\(--line\);/);
  assert.match(rule('.bet table'), /min-width: 44rem;/);
  assert.match(rule('.bet table'), /border-spacing: 0;/);
  // a line between every column and every row
  assert.match(rule('.bet th, .bet td'), /border-right: 1px solid var\(--line\);/);
  assert.match(rule('.bet th, .bet td'), /border-bottom: 1px solid var\(--line\);/);
  // short cells stay on one line, the long ones keep a floor width
  for (const sel of ['.bet td.member', '.bet td.ovr', '.bet td.engine, .bet td.done', '.bet th']) assert.match(rule(sel), /white-space: nowrap;/, sel);
  assert.match(rule('.bet td.role'), /min-width: \d+rem;/);
  assert.match(rule('.bet td.status'), /min-width: \d+rem;/);
  // the name column stays put while the rest scrolls under it
  assert.match(rule('.bet td.member'), /position: sticky; left: 0;/);
  // a card with a table gets the laptop's room; the others stay narrow
  assert.match(rule('body.wide .screen'), /max-width: 64rem;/);
  assert.match(html, /document\.body\.classList\.toggle\('wide', Boolean\(card\.table\)\);/);
  // same dark page: no glow, no shadow, no motion on the table
  const table = [...html.matchAll(/\n(\.bet t[^{]*|\.grid)\{([^}]*)\}/g)].map(m => m[2]).join('\n');
  assert.ok(table.length > 100);
  assert.doesNotMatch(table, /box-shadow|animation|transition|glow|filter/);
});

// finished plays for one member, the shape gm-season reads from the task list
function seasonPlays(member, kinds) {
  const out = [];
  let i = 0;
  for (const [kind, n] of Object.entries(kinds)) for (let k = 0; k < n; k += 1, i += 1) out.push({ event_id: `${member}-${i}`, task_id: `T${i}`, member, title: `job ${i}`, kind, at: NOW - (i + 1) * HOUR, claimed_at: NOW - (i + 2) * HOUR });
  return out;
}

test('over http: the team is a card, and a word to a member goes through the same token and json checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\n\n## build\n- claude code, model: opus 5.5\n');
  // installed tools come from the workspace's registry file, never this machine's PATH
  const checked = new Date().toISOString();
  const engines = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS).map(id => (id === 'claude' ? { id, health: { status: 'ready' } } : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);
  const ran = [];
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readSaid: async () => ({ ok: true, kind: 'instruction', reply: '' }), readMissions: () => new Map([['m1', { id: 'm1', owner: 'builder', status: 'running', objective: 'Write the try page.', created_at: new Date(NOW - 600000).toISOString(), last_tick_at: new Date(NOW - 60000).toISOString(), human_asks: [] }]]), driverAlive: () => true, loadSeason: () => ({ outcomes: seasonPlays('builder', { landed: 4, dropped: 1 }), error: null }), runCli: async (args) => { ran.push(args); return { code: 0, stdout: '{"ok":true,"action":"member_steered"}' }; } }),
  });
  const post = (body, over = {}) => h.call('POST', '/act', { body, ...over });
  try {
    assert.equal((await post({ open: 'team' }, { token: 'nope' })).status, 403);
    const team = (await post({ open: 'team' })).json.card;
    assert.equal(team.kind, 'team');
    assert.deepEqual(team.table.columns, ['member', 'role', 'ovr', 'engine', 'status']);
    assert.deepEqual(team.table.rows, [['builder', 'builder', '91', 'claude opus 5.5', 'working: write the try page, at it for 10 minutes']]);
    assert.deepEqual(team.options.map(o => o.id), ['talk:builder', 'swap:builder', 'deck', 'back']);
    const talk = (await post({ card_id: team.id, option_id: 'talk:builder' })).json.card;
    assert.deepEqual([talk.kind, talk.title, talk.input.action], ['member', 'builder', 'talk']);
    assert.equal((await post({ card_id: talk.id, text: 'hi' }, { token: 'nope' })).status, 403);
    const sent = await post({ card_id: talk.id, text: 'readme first' });
    assert.deepEqual([sent.status, sent.json.card.line], [200, 'sent to builder.']);
    assert.deepEqual(ran[0], ['member', 'steer', 'builder', '--no-ignite', '--json', '--', 'the owner says: readme first']);
  } finally {
    await h.close();
  }
});

test('over http: the job deck is a card through the same token check, one card per running job', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readMissions: () => new Map([['m1', { id: 'm1', owner: 'builder', status: 'running', runner: 'claude', objective: 'Write the try page.', created_at: new Date(NOW - 600000).toISOString(), last_tick_at: new Date(NOW - 60000).toISOString(), human_asks: [] }]]), driverAlive: () => true, loadSeason: () => ({ error: null, outcomes: ['landed', 'landed', 'landed', 'dropped'].map((kind, i) => ({ event_id: `e${i}`, task_id: `T-${i}`, member: 'builder', title: `job ${i}`, kind, at: NOW - (i + 1) * 3600000, claimed_at: NOW - (i + 2) * 3600000 })) }), resolveEngine: () => ({ engine: { id: 'claude' }, model: 'opus 5.5' }) }),
  });
  const post = (body, over = {}) => h.call('POST', '/act', { body, ...over });
  try {
    assert.equal((await post({ open: 'deck' }, { token: 'nope' })).status, 403);
    const deck = (await post({ open: 'deck' })).json.card;
    assert.equal(deck.kind, 'deck');
    // the deck card is about the job; the rating and the model live on the team table
    assert.deepEqual(deck.table.columns, ['done', 'work', 'member', 'role', 'status']);
    const row = deck.table.rows[0];
    assert.deepEqual([deck.count, deck.label, row[2], row[4]], ['1 of 1', 'working', 'builder', 'working']);
    assert.match(deck.body, /^builder is working on it, .*\. nothing needs you here\.$/);
    assert.deepEqual(deck.job, { member: 'builder', role: 'builder', ovr: '89', engine: 'claude opus 5.5' });
    // a job with no yes waiting has no yes on its card: a yes posted there does nothing
    const odd = await post({ card_id: deck.id, option_id: 'yes', confirm: true });
    assert.deepEqual([odd.status, odd.json.reason], [409, 'bad_option']);
    // its way back is the whole team, and the team's way back is the card under it (none here)
    const back = (await post({ card_id: deck.id, option_id: 'back' })).json.card;
    assert.equal(back.kind, 'team');
    assert.equal((await post({ card_id: back.id, option_id: 'back' })).json.card, null);
  } finally {
    await h.close();
  }
});

test('over http: a request from another site is refused on every route, reads too, and starts no work; the page\'s own requests still work', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const writes = [];
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, warmOnCreate: false, generate: (opts) => { writes.push(opts); return new Promise(() => {}); }, generateQuestion: () => new Promise(() => {}), runCli: async () => ({ code: 0, stdout: '{}' }) }),
  });
  try {
    const q = `?t=${TOKEN}`;
    for (const route of ['/', '/card', '/state']) {
      // a page on another site, with the key, fetching the route
      assert.equal((await h.call('GET', `${route}${q}`, { origin: 'http://evil.example' })).status, 403, `${route} with a foreign origin`);
      // an image or a link from another site sends no origin, only where it came from
      assert.equal((await h.call('GET', `${route}${q}`, { origin: null, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, `${route} from a cross-site fetch`);
      assert.equal((await h.call('GET', `${route}${q}`, { origin: null, headers: { 'sec-fetch-site': 'same-site' } })).status, 403, `${route} from another port`);
    }
    assert.equal((await h.call('POST', '/act', { body: { orb: true }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'a write from another site');
    assert.equal(writes.length, 0, 'nothing from another site started any work');
    // reading the card on screen starts no work either
    assert.equal((await h.call('GET', `/card${q}`, { origin: null, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal(writes.length, 0, 'a read starts no writer');
    // the page itself: opened from a scan or a text, then its own same-origin requests
    assert.equal((await h.call('GET', `/${q}`, { origin: null, headers: { 'sec-fetch-site': 'none' } })).status, 200);
    assert.equal((await h.call('GET', `/card${q}`, { origin: null })).status, 200, 'a plain client with the key still reads');
    assert.equal((await h.call('POST', '/act', { body: { orb: true }, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal(writes.length, 1, 'the first act fills the queue');
  } finally {
    await h.close();
  }
});

test('over http: opening the page itself from another site works, and every data route stays refused from one', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const writes = [];
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, warmOnCreate: false, generate: (opts) => { writes.push(opts); return new Promise(() => {}); }, generateQuestion: () => new Promise(() => {}), runCli: async () => ({ code: 0, stdout: '{}' }) }),
  });
  const q = `?t=${TOKEN}`;
  const open = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  // a plain request with exactly these headers, the way a browser sends a top-level open
  // (fetch would set its own sec-fetch-mode)
  const get = (route, headers) => new Promise((resolve, reject) => {
    const [host, port] = h.base.split(':');
    const req = http.request({ host, port, path: `${route}${q}`, method: 'GET', headers: { host: h.base, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    // the link tapped in a mail or chat app on the web: a top-level open of the page
    const page = await get('/', open);
    assert.equal(page.status, 200);
    assert.match(page.text, /<html/);
    // the same kind of request for any data route is still refused
    for (const route of ['/card', '/state']) assert.equal((await get(route, open)).status, 403, route);
    // the page from another site in a frame, or fetched, is refused
    assert.equal((await get('/', { ...open, 'sec-fetch-dest': 'iframe' })).status, 403);
    assert.equal((await get('/', { ...open, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status, 403);
    assert.equal(writes.length, 0, 'opening the page starts no work');
  } finally {
    await h.close();
  }
});

test('over http: the card route hands the desk only the card id, one option or the words, the second tap, the orb, and the footer', async () => {
  const calls = [];
  const h = await startHandler({
    makeBetDesk: () => ({
      card: () => ({ ok: true, card: null, status: 'idle' }),
      act: async (body) => { calls.push(body); return { status: 200, body: { ok: true, card: null } }; },
    }),
  });
  try {
    assert.equal((await h.call('POST', '/act', { body: { card_id: 'yes:m1:0', option_id: 'no', key: 'other', job: 'else', member: 'x' } })).status, 200);
    assert.equal((await h.call('POST', '/act', { body: { card_id: 'yes:m1:0', option_id: 'yes', confirm: true } })).status, 200);
    assert.equal((await h.call('POST', '/act', { body: { orb: true } })).status, 200);
    assert.equal((await h.call('POST', '/act', { body: { open: 'deck', card_id: 'idea:1' } })).status, 200);
    assert.equal((await h.call('POST', '/act', { body: { open: 'everything' } })).status, 200);
    assert.equal((await h.call('POST', '/act', { body: { card_id: 'q1', text: 'hi' } })).status, 200);
    assert.deepEqual(calls, [
      { card_id: 'yes:m1:0', option_id: 'no', confirm: false, orb: false, open: null },
      { card_id: 'yes:m1:0', option_id: 'yes', confirm: true, orb: false, open: null },
      { card_id: null, option_id: null, confirm: false, orb: true, open: null },
      { card_id: 'idea:1', option_id: null, confirm: false, orb: false, open: 'deck' },
      { card_id: null, option_id: null, confirm: false, orb: false, open: null },
      { card_id: 'q1', option_id: null, confirm: false, orb: false, open: null, text: 'hi' },
    ]);
    assert.equal((await h.call('POST', '/act', { body: { orb: true }, token: 'nope' })).status, 403);
    // the old routes are gone: every act goes through the card on screen
    for (const old of ['/bet/think', '/bet/yes', '/bet/no', '/bet/do', '/bet/answer', '/bet/say', '/bet/steer', '/bet/swap']) assert.equal((await h.call('POST', old, { body: { confirm: true } })).status, 404, old);
  } finally {
    await h.close();
  }
});

test('page: a yes card is drawn from its options: yes takes a second tap, no and not now are quiet; the need-you line opens the job deck; the small orb goes home from any card', () => {
  const gmCard = require('../lib/gm-card');
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // an option that asks for a second tap arms on the first and sends confirm on the second
  assert.match(script, /if \(o\.confirm\) \{/);
  assert.match(script, /armed = true; btn\.textContent = o\.confirm; btn\.classList\.add\('armed'\);/);
  assert.match(script, /send\(btn, \{ option_id: o\.id, confirm: true \}, o\);/);
  // the yes card's options come from the Mac: yes is the pill, no and not now quiet links on one line
  const y = gmCard.yes({ id: 'yes:m1:0', title: 'ok to publish the page?', body: 'builder is waiting on your yes for this.', request: { job: 'm1', key: 'm1:0', hash: null } });
  assert.deepEqual(y.options.map(o => [o.label, o.style]), [['yes', 'primary'], ['no', 'quiet'], ['not now', 'quiet']]);
  assert.equal(y.options[0].confirm, 'tap again to say yes');
  // quiet options next to each other share one line, and a group of them is headed by its words
  assert.match(script, /links = act\.appendChild\(el\('div', 'links'\)\);\n\s+group = o\.group \|\| null;\n\s+if \(group\) links\.appendChild\(document\.createTextNode\(group \+ ': '\)\);/);
  // the yeses still waiting: one small line, and its tap opens the job deck
  assert.match(html, /<button type="button" class="quiet" id="needs" hidden><\/button>/);
  assert.match(script, /n === 1 \? '1 needs you' : n \+ ' need you'/);
  // the small orb goes home from any card, a yes card too: nothing about the card can hold it
  assert.match(script, /function tapSmallOrb\(\) \{\n\s+if \(document\.body\.classList\.contains\('has-card'\)\) goHome\(\); else think\(\);/);
  const home = script.slice(script.indexOf('function goHome('), script.indexOf('function tapSmallOrb('));
  assert.doesNotMatch(home, /kind|yes|api\(/);
});

test('phone page: the job deck is cards like any other, flipped by the arrows or a sideways swipe through the card\'s own flip options', () => {
  const gmCard = require('../lib/gm-card');
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the arrows flip it, never while the owner types; a swipe flips only when it goes sideways
  assert.match(script, /var step = e\.key === 'ArrowLeft' \? -1 : e\.key === 'ArrowRight' \? 1 : 0;/);
  assert.match(script, /var o = optionFor\('flip', step\);/);
  assert.match(script, /Math\.abs\(dx\) > 50 && Math\.abs\(dx\) > Math\.abs\(dy\)/);
  assert.match(script, /useOption\(optionFor\('flip', dx < 0 \? 1 : -1\)\);/);
  // a flip turns the card in place; it is the same deck moving, not an answer
  assert.match(script, /var IN_PLACE = \['flip', 'more', 'scope'\];/);
  // a deck card: its place, its status, its row, the yes bound to its request, and a box to its member
  const d = gmCard.deck({ id: 'deck~1', at: 0, total: 2, columns: ['done', 'work', 'member', 'role', 'ovr', 'engine', 'status'], card: { job_id: 'm1', mission_id: 'm1', member: 'builder', label: 'needs you', time: 'waiting 5 minutes', rows: [{ done: 'not yet', work: 'the try page', member: 'builder', role: 'builder', ovr: '91', engine: 'tool one m-one', status: 'needs you' }], yes: { key: 'm1:step-3:abc', hash: 'abc', what: 'ok to publish the page?', why: 'builder is waiting on your yes for this.' } } });
  assert.deepEqual([d.count, d.label], ['1 of 2', 'needs you']);
  assert.deepEqual(d.options.map(o => o.label), ['yes', 'no', 'not now', 'previous', 'the whole team', 'next']);
  assert.deepEqual(d.options[0].binds, { job: 'm1', key: 'm1:step-3:abc', hash: 'abc' });
  assert.equal(d.input.action, 'talk');
  assert.deepEqual(gmCard.cardProblems(d), []);
  // no pulsing or looping anywhere
  assert.doesNotMatch(html, /infinite/);
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
});

test('phone link: the token is kept per workspace, private to this user, and reused until --new-link', { skip: process.platform === 'win32' }, () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-links-'));
  const file = path.join(stateDir, 'gm-phone-links.json');
  const first = phone.phoneToken('/ws/shop', { stateDir });
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.reused, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only this user can read it');
  // a restart: the same link
  assert.deepEqual(phone.phoneToken('/ws/shop', { stateDir }), { token: first.token, reused: true });
  // another workspace gets its own
  const other = phone.phoneToken('/ws/lab', { stateDir });
  assert.notEqual(other.token, first.token);
  assert.equal(phone.phoneToken('/ws/lab', { stateDir }).token, other.token);
  // --new-link: a new token, saved, and the old one is gone
  const rotated = phone.phoneToken('/ws/shop', { stateDir, rotate: true });
  assert.notEqual(rotated.token, first.token);
  assert.equal(rotated.reused, false);
  assert.equal(phone.phoneToken('/ws/shop', { stateDir }).token, rotated.token);
  assert.equal(phone.phoneToken('/ws/lab', { stateDir }).token, other.token, 'rotating one leaves the others');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // a file loosened by hand is tightened again; a broken file just makes a new link
  fs.chmodSync(file, 0o644);
  phone.phoneToken('/ws/shop', { stateDir });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'not json');
  const fresh = phone.phoneToken('/ws/shop', { stateDir });
  assert.match(fresh.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fresh.reused, false);
  // a saved token that is not a real one is never reused
  fs.writeFileSync(file, JSON.stringify({ '/ws/shop': { token: 'short' } }));
  assert.notEqual(phone.phoneToken('/ws/shop', { stateDir }).token, 'short');
});

test('phone link: gm help names --new-link', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'gm.js'), 'utf8');
  assert.match(src, /--new-link\s+gm phone: make a new link; the old one stops working\./);
  assert.match(src, /phone\.phoneToken\(workspaceRoot, \{ stateDir, rotate: hasExactFlag\(args, '--new-link'\) \}\)/);
});

test('page: a card\'s box is its input: a quiet line that turns into the field in its own spot, and the words go to the Mac with the card id', () => {
  const gmCard = require('../lib/gm-card');
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.match(script, /var open = wrap\.appendChild\(el\('button', 'quiet', input\.label \|\| 'or say something'\)\);/);
  assert.match(script, /typeHere\(open, input\.placeholder \|\| 'say something', input\.max \|\| 280, function \(text, field\) \{ send\(field, \{ text: text \}, null\); \}\);/);
  // an option that takes words (something else) turns into the field the same way
  assert.match(script, /if \(o\.type\) \{ typeHere\(btn, o\.type\.placeholder \|\| o\.label, o\.type\.max \|\| 280, function \(text, field\) \{ send\(field, \{ option_id: o\.id, text: text \}, o\); \}\); return; \}/);
  // the field takes the tapped button's own height to the subpixel, so nothing under it moves
  assert.match(script, /field\.style\.height = btn\.getBoundingClientRect\(\)\.height \+ 'px';/);
  // the same words carry the same id on every try, so a retry never sends twice
  assert.match(script, /if \(body\.text\) body\.send = sendId\(\[from\.id, option \? option\.id : 'the box', body\.text\]\.join\(' \| '\)\);/);
  // words that did not go through come back in their box, and one line says why
  assert.match(script, /field\.querySelector\('input'\)\.value = typed;/);
  assert.match(script, /if \(note\) note\.textContent = \(r && r\.http === 409 && r\.message\) \|\| \(r && r\.http === 0 && r\.message\) \|\| 'that did not go through\. try again\.';/);
  // every card that takes words gets its box from the Mac: the one place to type
  const ask = { job: 'm1', key: 'm1:0', hash: null };
  for (const c of [gmCard.idea({ id: 'b1', title: 't', body: 'b' }), gmCard.yes({ id: 'y1', title: 't', body: 'b', request: ask }), gmCard.done({ id: 'd1', title: 't', body: 'b' }), gmCard.wait({ id: 'w1' }), gmCard.choice({ id: 'c1', items: [{ id: 'b1', title: 't', why: 'w.' }] })]) {
    assert.equal(c.input.label, 'or say something', c.kind);
  }
  // a question with its own something else has no second box: that answer turns into the field
  const q = gmCard.question({ id: 'q1', title: 'which number?', choices: [{ id: 's1', label: 'installs' }, { id: 'other', label: 'something else', other: true }] });
  assert.equal(q.input, null);
  assert.deepEqual([q.options[1].action, q.options[1].type], ['say', { placeholder: 'something else', max: 60 }]);
});

test('over http: say something goes through the same token and json checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readSaid: async () => ({ ok: true, kind: 'answer', reply: '' }), runCli: async () => ({ code: 0, stdout: '{}' }) }),
  });
  const post = (body, over = {}) => h.call('POST', '/act', { body, ...over });
  try {
    const shown = (await post({ orb: true })).json.card;
    assert.equal((await post({ card_id: shown.id, text: 'hi' }, { token: 'nope' })).status, 403);
    assert.equal((await post({ card_id: shown.id, text: 'hi' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ card_id: shown.id, text: 'x'.repeat(281) })).json.reason, 'too_long');
    assert.equal((await post({ card_id: shown.id, text: '  ' })).json.reason, 'empty');
    const ok = await post({ card_id: shown.id, text: 'more people using it, in schools' });
    assert.deepEqual([ok.status, ok.json.ack], [200, 'got it: more people using it, in schools.']);
  } finally {
    await h.close();
  }
});

test('page: the weekly number card is its number box and a quiet not now', () => {
  const gmCard = require('../lib/gm-card');
  const r = gmCard.report({ id: 'report:2026-10-21', title: 'paying schools: what is it this week?', body: 'one number a week shows if this is going well.' });
  assert.deepEqual([r.input.action, r.input.label], ['report', 'type this week\'s number']);
  assert.deepEqual(r.options.map(o => [o.id, o.label]), [['later', 'not now']]);
  assert.deepEqual(gmCard.cardProblems(r), []);
});

test('over http: the weekly number goes through /act with the same checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  let dirSeen = null;
  const h = await startHandler({
    // something else is read first; the reader takes paying schools as the answer
    makeBetDesk: (log, dir) => { dirSeen = dir; return gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, scoreboard: true, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readSaid: async () => ({ ok: true, kind: 'answer', reply: '' }), runCli: async () => ({ code: 0, stdout: '{}' }) }); },
  });
  const post = (body, over = {}) => h.call('POST', '/act', { body, ...over });
  try {
    const q = (await post({ orb: true })).json.card;
    assert.equal(q.title, 'what number tells you this is going well?');
    const named = await post({ card_id: q.id, option_id: 'other', text: 'paying schools' });
    assert.equal(named.json.ack, 'got it: paying schools.');
    const r = named.json.card;
    assert.equal(r.kind, 'report');
    assert.equal((await post({ card_id: r.id, text: '3' }, { token: 'nope' })).status, 403);
    const saved = await post({ card_id: r.id, text: '3' });
    assert.deepEqual([saved.status, saved.json.ack], [200, 'saved: 3.']);
    assert.deepEqual(gmBet.readScoreboard(gmBet.scoreboardPath(dirSeen), root).reports.map(x => x.value), [3]);
  } finally {
    await h.close();
  }
});

test('phone link: a rotated link is dead at once in every running server', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-rot-'));
  const first = phone.phoneToken('/tmp/shop', { stateDir }).token;
  const h = await startHandler({ token: () => phone.readPhoneToken('/tmp/shop', { stateDir }) });
  try {
    assert.equal((await h.call('GET', '/state', { token: first })).status, 200);
    const next = phone.phoneToken('/tmp/shop', { stateDir, rotate: true }).token;
    assert.equal((await h.call('GET', '/state', { token: first })).status, 403, 'the old link is dead in the server already running');
    assert.equal((await h.call('GET', '/state', { token: next })).status, 200, 'the new link works in it');
    // no saved link: nothing gets in
    fs.rmSync(path.join(stateDir, 'gm-phone-links.json'));
    assert.equal((await h.call('GET', '/state', { token: next })).status, 403);
  } finally {
    await h.close();
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'gm.js'), 'utf8');
  assert.match(src, /token: \(\) => phone\.readPhoneToken\(workspaceRoot, \{ stateDir \}\)/);
  assert.match(src, /the old link is dead now, even in a phone page that is still open\./);
});

test('target snapshot restores the file exactly, or removes one that was not there', () => {
  const gmTarget = require('../lib/gm-target');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-target-'));
  try {
    const root = path.join(dir, 'ws');
    const file = gmTarget.targetsPath(root, dir);
    const restoreNone = phone.targetSnapshot(root, dir);
    assert.equal(gmTarget.writeTarget(root, { landed: 19, max_abandoned: 2, max_stuck: 0 }, { dir }), true);
    assert.equal(fs.existsSync(file), true);
    assert.equal(restoreNone(), true);
    assert.equal(fs.existsSync(file), false);

    gmTarget.writeTarget(root, { landed: 5, max_abandoned: 1, max_stuck: 0 }, { dir });
    const before = fs.readFileSync(file, 'utf8');
    const restore = phone.targetSnapshot(root, dir);
    gmTarget.writeTarget(root, { landed: 30, max_abandoned: 1, max_stuck: 0 }, { dir });
    assert.notEqual(fs.readFileSync(file, 'utf8'), before);
    assert.equal(restore(), true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lan address skips loopback and link-local, prefers en0', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    bridge0: [{ family: 'IPv4', address: '169.254.3.4', internal: false }],
    en5: [{ family: 'IPv4', address: '10.0.0.9', internal: false }],
    en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.23', internal: false }],
  };
  assert.equal(phone.lanAddress(ifaces), '192.168.1.23');
  assert.equal(phone.lanAddress({ lo0: ifaces.lo0 }), null);
});

test('page: one accent, no em dashes, text goes in as text', () => {
  const html = phonePage('NONCE');
  assert.equal((html.match(/nonce="NONCE"/g) || []).length, 2);
  assert.equal(html.includes(String.fromCharCode(0x2014)), false);
  assert.doesNotMatch(html, /innerHTML|backdrop-filter|infinite/);
  // the only motion that loops is the ported lava orb's drift, and it is
  // paused once the bet card is up and off under reduced motion
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
  assert.match(html, /\.lava\.still \.tx, \.lava\.still \.ty, \.lava\.still \.blob \{ animation-play-state: paused; \}/);
  assert.match(html, /prefers-reduced-motion: reduce\) \{\n {2}\.lava \.tx, \.lava \.ty, \.lava \.blob \{ animation: none !important; \}/);
  // tap targets stay at least 44px
  assert.match(html, /\.pill \{\n {2}min-width: 12rem; height: 44px;/);
  assert.match(html, /\.choice \{ width: 100%; min-height: 52px;/);
});

test('page: only the orb, its cards, and the working count; big type and no plumbing words', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the old decision sheet is gone from the phone: no only-you link, no review asks, no target strip
  for (const gone of ['open-only', 'id="sheet"', 'only you', "'/state'", "'/action'", 'toast', 'oldest', 'target']) assert.equal(html.includes(gone), false, gone);
  // the footer: the working count, or the team when nothing runs, and the small need-you line while yeses wait
  assert.match(html, /<div class="foot" id="foot"><button type="button" class="quiet" id="needs" hidden><\/button><button type="button" class="quiet" id="working">the team<\/button><\/div>/);
  // no small text anywhere on the page
  const sizes = [...html.matchAll(/font-size: (\d+)px/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 3);
  assert.ok(sizes.every(n => n >= 17), `font sizes ${sizes.join(', ')}`);
  // the words an owner never needs to read: none anywhere in the page, and
  // no sentence the page writes says check or test
  assert.doesNotMatch(html, /receipt|review|proof|running_for/i);
  const copy = [...script.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map(m => m[1]).filter(t => / /.test(t) && !/[();]/.test(t));
  assert.ok(copy.length > 10);
  for (const t of copy) assert.doesNotMatch(t, /\bcheck|\btest/i, t);
});

test('page: an act holds the chosen spot, then one motion: the card fades into the sphere, the dots spiral in once the answer is in, and the next card blooms', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the hold, then the motion; the answer is asked for at once, during the hold
  assert.match(script, /var heldAt = hold\(spot\);\n\s+var answer = api\('\/act', body\)\.catch\(offline\);/);
  assert.match(script, /afterHold\(heldAt\)\.then\(function \(\) \{ flow\(answer, from, body\.text, option\); \}\);/);
  // the sphere waits in its idle drift until the answer lands; the dots spiral in only then
  assert.match(script, /leave\(function \(\) \{ sphere = true; land\(\); \}, true\);/);
  assert.match(script, /if \(!landed \|\| !sphere\) return;/);
  // a line from the Mac (who has it now) shows under the sphere for AFTER_MS before the next card
  assert.match(script, /if \(r\.ok && r\.ack\) \{ lineAt = performance\.now\(\); line\.set\(r\.ack, false\); \}/);
  assert.match(script, /var AFTER_MS = 1500;/);
  // the next card blooms where the dots land, as the sphere settles to the small orb
  assert.match(script, /if \(phase === 'cover'\) \{ showCard\(card, true, true, true\); if \(after\) after\(\); \}/);
  // reduced motion: no spiral, the card fades in where it goes
  assert.match(script, /if \(reduced\) \{ orb\.settled\(\); showCard\(card, true\); bet\.busy = false; if \(after\) after\(\); return; \}/);
  // the card fades all the way before it leaves the page, and the sphere comes back swarming, not idle
  assert.match(html, /\.bet\.leave\.fast \{ transition: opacity 0\.2s ease-in-out; \}/);
  assert.match(script, /var ACT_LEAVE_MS = 220,/);
  assert.match(script, /mode = fast \? 'swarm' : 'idle';/);
  // no thinking text: nothing under the sphere while it waits but the Mac's own line
  assert.doesNotMatch(script, /thinking|line\.set\('\\u2026/);
});

test('page: while the next card is on its way the dots keep moving; on the calm line the sphere stays, its box is open, and a note goes on the calm line\'s own id', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
  // the swarm is the dots themselves: the sphere turns faster and each dot wanders its own loop,
  // eased in and out; it never runs under reduced motion and stops once a card is up
  assert.match(script, /var swarming = mode === 'swarm' && !reduced;/);
  assert.match(script, /swarmK \+= \(\(swarming \? 1 : 0\) - swarmK\) \* toward;/);
  assert.match(script, /homeX \+= Math\.sin\(clock \* d\.f1 \+ d\.p1\) \* wander;/);
  assert.match(script, /if \(mode === 'card' \|\| \(reduced && \(mode === 'idle' \|\| mode === 'swarm'\)\)\) \{ raf = 0; return; \}/);
  // no glow loop and no keyframes of its own: motion of the dots, drawn frame by frame
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
  // a spiral starts from the dots' own speed, so they turn inward without a stop
  assert.match(script, /d\.kx \+= d\.vx; d\.ky \+= d\.vy; d\.vx \*= CARRY; d\.vy \*= CARRY;/);
  // the calm line: the sphere stays on the page with its dots swarming, and the card under it takes no room
  assert.match(script, /function enterWait\(card, atOnce\) \{[\s\S]*?orb\.swarm\(\);[\s\S]*?document\.body\.classList\.add\('has-card', 'waiting'\);/);
  assert.match(html, /body\.has-card\.waiting \.stage \{ display: block; transform: translateY\(var\(--wait-dy, 0px\)\) scale\(var\(--wait-k, 1\)\); \}/);
  assert.match(html, /body\.waiting \.bet \{ position: absolute;/);
  assert.match(html, /\.stage \{ transform-origin: 50% 0; transition: transform 0\.6s cubic-bezier\(0\.65, 0, 0\.35, 1\); \}/);
  // its box is open from the start and stays open, without taking the cursor
  assert.match(script, /if \(box\(\)\.getAttribute\('data-kind'\) === 'wait'\) typeHere\(open, input\.placeholder \|\| 'add a note for this idea', input\.max \|\| 280, function \(text, field\) \{ sendNote\(field, text\); \}, true\);/);
  assert.match(script, /if \(stay \|\| input\.value\.trim\(\) \|\| field\.classList\.contains\('chosen'\) \|\| !field\.isConnected\) return;/);
  assert.match(script, /if \(stay\) return field;\n\s+dimOthers\(field\);\n\s+input\.focus\(\);/);
  // a note names the calm line and carries its own send id; the card stays, and only its live words change
  assert.match(script, /var body = \{ card_id: from\.id, text: text, send: sendId\(\[from\.id, 'the box', text\]\.join\(' \| '\)\) \};/);
  assert.match(script, /if \(r\.ok && r\.card && sameCard\(r\.card, from\)\) \{ input\.value = ''; input\.blur\(\); live\(r\.card\); return; \}/);
  // the live words: the newest drafting line on the card, how long it has been (the Mac's own
  // count, carried on), and the newest note with its answer
  assert.match(script, /var lines = Array\.isArray\(card\.progress\) \? card\.progress : \[\];/);
  assert.match(script, /if \(Number\.isFinite\(card\.waited_ms\)\) waitClock = \{ key: String\(card\.id\)\.split\('#'\)\[0\], ms: card\.waited_ms, at: Date\.now\(\) \};/);
  assert.match(script, /var began = typeof card\.started_at === 'number' \? card\.started_at : Date\.parse\(card\.started_at \|\| ''\);/);
  assert.match(script, /var want = turns\.slice\(-2\);/);
  // the idea lands: the calm line's words fade while the dots spiral in, and it grows out of the point
  assert.match(script, /function landFromWait\(card, after\) \{[\s\S]*?orb\.play\(function \(phase\) \{\n\s+if \(phase === 'cover'\) \{ off\(\); showCard\(card, true, true, true\); if \(after\) after\(\); \}/);
  // the idea waits while the owner types there or a note is on its way
  assert.match(script, /var quiet = function \(\) \{ return !bet\.busy && !bet\.noting && document\.body\.classList\.contains\('has-card'\) && !typingOnCard\(\); \};/);
  // the footer steps aside while a card moves, so it never jumps between places
  assert.match(html, /body\[data-busy\]:not\(\[data-in-place\]\) \.foot \{ opacity: 0; transition: opacity 0\.15s ease-in; \}/);
});

test('page: under reduced motion nothing travels or swarms, and every card change is a plain fade', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const block = html.split('@media (prefers-reduced-motion: reduce) {')[1].split('\n}')[0];
  // the cards fade, the sphere and the live words never ease from place to place
  assert.match(block, /\.bet \{ transform: none; transition: opacity 0\.2s linear; \}/);
  assert.match(block, /\.bet\.quick, \.bet\.acted, \.bet\.leave, \.bet\.leave\.fast, \.bet\.wait-in \{ transform: none; transition: opacity 0\.2s linear; \}/);
  assert.match(block, /\.stage, \.waitstep, \.waitnotes, \.waitnotes \.turn \{ transition: none; \}/);
  // the sphere fades in at a new place instead of moving there
  assert.match(script, /function stageFade\(\) \{\n\s+if \(!reduced\) return;/);
  assert.match(script, /if \(!was\) \{ placeWait\(!atOnce && !reduced\); stageFade\(\); \}/);
  // leaving a card: it fades, then the sphere is there; an idea from the calm line fades in
  assert.match(script, /setTimeout\(function \(\) \{ swap\(\); stageFade\(\); orb\.melt\(then, to, function \(\) \{\}, fast\); \}, 200\);/);
  assert.match(script, /setTimeout\(function \(\) \{ off\(\); orb\.settled\(\); showCard\(card, true\); bet\.busy = false; if \(after\) after\(\); \}, 200\);/);
  // the dots are drawn once and hold
  assert.match(script, /if \(!reduced && \(mode === 'idle' \|\| mode === 'swarm'\)\) angle \+= dt \* spin;/);
});

test('page: the idle orb answers the pointer like the landing orb, and only the pointer', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // StippleOrb's constants, copied: dots within RADIUS are pushed out by PUSH,
  // then spring home; the ripple runs out from where the pointer came in
  assert.deepEqual(['RADIUS', 'PUSH', 'SPRING', 'DAMP', 'WAVE_SPEED', 'WAVE_WIDTH', 'WAVE_LIFE'].map(num), [90, 14, 0.07, 0.8, 620, 70, 1.6]);
  // the push only in the resting sphere (idle, or swarming while a card is on its way), never under reduced motion
  assert.match(script, /if \(mode === 'idle' \|\| mode === 'swarm'\) \{\n\s+var homeX = cx \+ rx \* R, homeY = cy \+ d\.y \* R;/);
  assert.match(script, /if \(pointer\.inside && !reduced\) \{/);
  assert.match(script, /var f = \(1 - dist \/ RADIUS\) \* PUSH;\n\s+d\.vx \+= \(dx \/ dist\) \* f \* 0\.2;/);
  // the light eases toward the pointer anywhere on the page (trackWindow), as on the landing page
  assert.match(script, /light\.x \+= \(light\.tx - light\.x\) \* 0\.06;/);
  assert.match(script, /var reach = Math\.max\(280, window\.innerWidth \* 0\.4\);/);
  assert.match(script, /window\.addEventListener\('pointermove', lightFrom\);/);
  // the ripple starts where the pointer enters the orb
  assert.match(script, /canvas\.addEventListener\('pointerenter', function \(e\) \{/);
  // pointer events go through to the dots on touch too; a tap on the big orb
  // still thinks, and the small one on a card goes back to it
  assert.match(html, /\.stage canvas \{[^}]*touch-action: none;/);
  assert.match(script, /\[\[canvas, think\], \[lavaTap, tapSmallOrb\]\]/);
  assert.match(script, /pair\[0\]\.addEventListener\('click', pair\[1\]\);/);
  // still no loop of its own: no new keyframes, and the tap timings are untouched
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
  assert.deepEqual(['GROW_MS', 'SETTLE_MS', 'LEAVE_MS', 'GLIDE_MS', 'BEAT_MS', 'FAST_GROW_MS', 'FAST_SETTLE_MS', 'FAST'].map(num), [1050, 900, 400, 520, 340, 460, 440, 0.4]);
});

test('page: in place, a card turns into the next: crossfade, a small drift, the box eases its height, the orb stays still', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // short and soft: one crossfade with a small drift, well under half a second
  assert.equal(num('TURN_IN_MS'), 320);
  assert.equal(num('DRIFT'), 4);
  assert.ok(80 + num('TURN_IN_MS') < 500, 'a turn is well under half a second');
  // only the same card moving turns in place (a deck flip, more models, who a swap is
  // for); an answer is the one motion through the sphere, and the calm line's idea
  // grows out of its dots
  assert.match(script, /if \(option && \(IN_PLACE\.indexOf\(option\.action\) >= 0 \|\| around\)\) \{/);
  // moving around the team pages is a place to go, not an answer: it turns in place too
  assert.match(script, /var AROUND = \['member', 'swap', 'deck', 'back', 'swap_to'\];/);
  assert.match(script, /if \(r\.ok && r\.card && !sameCard\(r\.card, bet\.shown\)\) \{ arrive\(r\.card\); return; \}/);
  assert.match(script, /function arrive\(card\) \{\n\s+if \(waiting\(\)\) \{ landFromWait\(card\); return; \}/);
  // the box holds its height while the old card leaves, then eases to the new one
  assert.match(script, /var from = b\.offsetHeight;\n\s+b\.style\.height = from \+ 'px';\n\s+b\.style\.minHeight = '';/);
  assert.match(script, /b\.style\.height = to \+ 'px';/);
  // the transitions: opacity, a small transform, and height; no new loops
  assert.match(html, /\.bet\.turning \{ overflow: hidden; transition: opacity 0\.32s ease-out 0\.08s, transform 0\.32s cubic-bezier\(0\.22, 1, 0\.36, 1\) 0\.08s, height 0\.36s cubic-bezier\(0\.4, 0, 0\.2, 1\); \}/);
  assert.match(html, /\.bet\.ghost\.gone \{ opacity: 0; \}/);
  // the still copy sits exactly over the card, measured to the subpixel
  assert.match(script, /ghost\.style\.top = \(r\.top - p\.top\) \+ 'px';/);
  assert.match(html, /\.bet\.turn-in \{ opacity: 0; transform: translateY\(4px\); transition: none; \}/);
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
  // reduced motion: the new card simply takes the old one's place
  assert.match(script, /if \(reduced\) \{ b\.style\.minHeight = ''; paint\(\); after\(\); return; \}/);
  // leaving to the sphere clears the height lock too
  assert.match(script, /var swap = function \(\) \{\n\s+b\.style\.minHeight = '';/);
});

test('page: a tap on a card fades it, glides home to the sphere, and the fast bloom stays contained', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the page script parses
  assert.doesNotThrow(() => new Function(script));
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // the card fades out softly in place, never a cut
  assert.match(html, /\.bet\.leave \{ opacity: 0; transform: none; transition: opacity 0\.4s ease-out; \}/);
  assert.equal(num('LEAVE_MS'), 400);
  // the small orb glides to where the sphere will sit, read before anything moves;
  // an act takes the short glide
  assert.match(script, /var to = sphereSpot\(\);/);
  assert.match(script, /orb\.melt\(then, to, swap, fast\);/);
  assert.match(script, /var leaveMs = fast \? ACT_LEAVE_MS : LEAVE_MS, glideMs = fast \? ACT_GLIDE_MS : GLIDE_MS, beatMs = fast \? ACT_BEAT_MS : BEAT_MS;/);
  // the sphere grows back and holds for a beat before the next reveal
  assert.ok(num('BEAT_MS') >= 200);
  // the queued bet's bloom stays under 80% of the smaller window side and never dims the
  // page; after an act it is smaller still
  assert.ok(num('BLOOM') < 0.8);
  assert.ok(num('ACT_BLOOM') < num('BLOOM'));
  assert.match(script, /var bloom = quick \? ACT_BLOOM : BLOOM;/);
  assert.match(script, /bloom \* Math\.min\(window\.innerWidth, window\.innerHeight\) \/ 2/);
  // a contained bloom is one motion: born at the point the dots drew, swelling on a soft
  // curve while it already drifts up, then easing into the small orb with no stop
  assert.match(script, /var vx = rect\.left \+ rect\.width \/ 2, vy = rect\.top \+ rect\.height \/ 2;/);
  assert.match(script, /if \(contained\) \{ rise\(growMs, settleMs, sMin, sMax, rest\); return; \}/);
  assert.match(script, /var s = u < k \? sMin \+ \(sMax - sMin\) \* \(0\.5 - 0\.5 \* Math\.cos\(Math\.PI \* u \/ k\)\) : sMax \+ \(rest - sMax\) \* ease\(\(u - k\) \/ \(1 - k\)\);/);
  assert.match(script, /var m = ease\(u\);\n\s+place\(s, origin\.x \+ \(p\.x - origin\.x\) \* m, origin\.y \+ \(p\.y - origin\.y\) \* m, now\);/);
  // the lava is at the point before it can be seen
  assert.match(script, /lava\.style\.opacity = '0';\n\s+place\(sMin, origin\.x, origin\.y\);\n\s+lava\.style\.visibility = 'visible';/);
  assert.match(script, /dim\.style\.opacity = contained \? '0'/);
  // the bet still being made keeps the full grow toward the farthest corner
  assert.match(script, /var growMs = quick \? ACT_GROW_MS : contained \? FAST_GROW_MS : \(GROW_MS \* pace\);/);
  // the small orb's way home, then the big orb's tap to the card: glide, beat, pull, bloom, settle, card fade
  const pull = 1.05 * num('FAST') * 1000;
  const total = num('GLIDE_MS') + num('BEAT_MS') + pull + num('FAST_GROW_MS') + num('FAST_SETTLE_MS') + 120;
  // unhurried but never a wait: about two seconds
  assert.ok(total >= 1800 && total <= 2500, `fast re-tap budget ${total}ms`);
});

// ---- typing on a card is a dialogue box: the eyes stay in one place ------------------

const trace = require('../scripts/gm-phone-trace');
const CHROME = trace.findChrome();

test('browser: the tapped spot becomes the field, holds as chosen, and the next title lands where the old one was', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.trace({ chromePath: CHROME });
  assert.equal(out.failed, null, JSON.stringify(out.stretches));
  const [typed, said, answered, idea] = out.stretches;
  const show = s => JSON.stringify(s);
  // one: "something else" turns into the field at the same size and spot, the
  // cursor already in it; the other answers dim and stay put
  assert.deepEqual(typed.field_vs_button_px, { moved: 0, resized: 0 }, show(typed));
  assert.equal(typed.cursor_in_field, true);
  assert.ok(typed.others_dimmed_to < 0.6, show(typed));
  // "or say something" does the same in its own spot, at the same height
  assert.deepEqual(said.field_vs_button_px, { center_moved: 0, height_change: 0 }, show(said));
  assert.equal(said.cursor_in_field, true);
  for (const s of [typed, said, answered, idea]) {
    // the typed words or the tapped answer hold in that spot, styled as
    // chosen, for a beat, and nothing else on the card moves
    assert.equal(s.held_as_chosen, true, show(s));
    assert.equal(s.held_moved_px, 0, show(s));
    assert.equal(s.others_moved_px, 0, show(s));
    assert.ok(s.hold_ms >= 120 && s.hold_ms <= 600, show(s));
    // then one motion: the card goes into the sphere and the next one comes out of it,
    // its title landing where the old title was, a few pixels of drift at most
    assert.equal(s.through_sphere, true, show(s));
    assert.ok(s.title_max_px <= 5, show(s));
    assert.equal(s.title_rest_px, 0, show(s));
    assert.ok(s.largest_frame_step_px <= 5, show(s));
    // tap to the next card fully in: about a second, step by step as the page
    // sets its motion, so a busy machine's late frames never count against it.
    // each step runs for real, at least about half of what it is set to today,
    // so a step cut to nothing fails even when the order and the total fit
    const floors = { hold: 120, glide: 130, beat: 50, spiral: 150, bloom: 70, fade: 150 };
    assert.deepEqual(s.motion.map(([step]) => step), Object.keys(floors), show(s));
    for (const [step, ms] of s.motion) assert.ok(ms >= floors[step], `${step} ${ms}ms: ${show(s)}`);
    assert.ok(s.motion_ms >= 900 && s.motion_ms <= 1250, show(s));
    // the clock is the motion plus the wait on the stub desk (its own speed,
    // left out) plus late timers and frames. it never beats the motion by
    // more than the one frame the spiral can start into. what a slow machine
    // adds stays within a dozen frames at its pace (about how many times the
    // motion waits on a timer or a frame), and never past twice the motion
    // whatever the frames, so a page that freezes fails. 16 times slower, the
    // machine added at most 1.7 seconds
    assert.ok(Number.isFinite(s.reveal_ms) && Number.isFinite(s.waited_ms), show(s));
    assert.ok(s.late_ms >= -s.slowest_frame_ms, show(s));
    assert.ok(s.late_ms <= Math.min(12 * s.pace_frame_ms, 2 * s.motion_ms), show(s));
  }
  for (const s of [answered, idea]) assert.ok(s.others_dimmed_to < 0.6, show(s));
  // a reply instead of a card takes the title's spot; it only explains, so the
  // idea's own options are on it once, with the answers it adds and its box
  assert.equal(said.next_title, trace.REPLY);
  assert.deepEqual(said.reply.buttons, ['do it', 'sounds good', 'make it shorter', 'sharper idea', 'not now', 'or say something']);
});

test('page: an act to the next card is one motion of about a second when the answer is in', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // the hold, the glide into the sphere, the beat it re-forms, the spiral, the bloom, and the card's fade up
  const pull = 1.05 * num('ACT_PACE') * 1000;
  const fade = Number(/\.bet\.acted \{ transform: translateY\(4px\); transition-duration: ([0-9.]+)s/.exec(html)[1]) * 1000;
  const total = num('HOLD_MS') + num('ACT_GLIDE_MS') + num('ACT_BEAT_MS') + pull + num('ACT_GROW_MS') + fade;
  assert.ok(total >= 900 && total <= 1250, `tap to card ${total}ms`);
  // the bloom after an act is the contained one and never dims the page
  assert.match(script, /var growMs = quick \? ACT_GROW_MS : contained \? FAST_GROW_MS : \(GROW_MS \* pace\);/);
  assert.match(script, /pace = act \? ACT_PACE : fast \? FAST : 1;/);
  // the field takes the tapped button's own height to the subpixel, so nothing under it moves
  assert.match(script, /field\.style\.height = btn\.getBoundingClientRect\(\)\.height \+ 'px';/);
});

// ---- Esc on the team page: one layer back per press -------------------------------

test('page: Esc cancels the typing first, then takes the card\'s own way back, and does nothing on a card with none', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /if \(field && field\.tagName === 'INPUT'\) \{\n\s+e\.preventDefault\(\);\n\s+field\.value = '';\n\s+field\.blur\(\);/);
  assert.match(script, /var back = optionFor\('back'\);\n\s+if \(back\) \{ e\.preventDefault\(\); useOption\(back\); \}/);
});

test('browser: Esc cancels the typing, then steps back one card at a time, and does nothing on a card with no way back', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const { steps } = await trace.escapeTrace({ chromePath: CHROME });
  const show = JSON.stringify(steps, null, 1);
  const at = did => {
    const s = steps.find(x => x.did === did);
    assert.ok(s, `no step ${did}: ${show}`);
    const { did: _, under_orb: __, ...rest } = s;
    return rest;
  };
  const card = at('the card');
  assert.equal(card.kind, 'question', show);
  // on the first card Esc does nothing at all
  assert.deepEqual(at('esc on the card'), card, show);
  // the team is a card; a row opens the talk card; typing there
  assert.deepEqual([at('opened the team').kind, at('opened the team').title], ['team', 'the team'], show);
  const typing = at('typing to builder');
  assert.deepEqual([typing.kind, typing.typing, typing.words], ['member', true, 'take the readme first'], show);
  // Esc while typing: the words go and the cursor leaves; the talk card stays
  const cancelled = at('esc while typing');
  assert.deepEqual([cancelled.kind, cancelled.field_open, cancelled.typing], ['member', false, false], show);
  // the words sent ask for a second tap to start builder, on a card of their own
  assert.deepEqual(at('sent to builder').buttons.slice(0, 3), ['start it', 'keep it as a note instead', 'back'], show);
  // then one card back per press: the talk card, the team, the first card, and nothing more
  assert.equal(at('esc 1').kind, 'member', show);
  assert.equal(at('esc 2').kind, 'team', show);
  assert.deepEqual(at('esc 3'), card, show);
  assert.deepEqual(at('esc 4'), card, show);
});

// ---- an answer goes to the question on screen, or nowhere ---------------------------

test('over http: an answer and a say name the card on screen; a page that missed the next card saves nothing', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  // written questions reuse answer ids: a2 is small teams on one, fewer mistakes on the next
  const list = [
    { ask: 'who uses the phone page most?', fact: 'the phone page went live this week.', choices: ['solo founders', 'small teams'] },
    { ask: 'what would make a small team pay?', fact: 'installs dropped to 1,511 last week.', choices: ['saving them hours', 'fewer mistakes'] },
  ];
  let n = 0;
  let dirSeen = null;
  const h = await startHandler({
    makeBetDesk: (log, dir) => {
      dirSeen = dir;
      return gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, generate: () => new Promise(() => {}), generateQuestion: () => Promise.resolve(list[n] ? { ok: true, question: list[n++] } : { ok: false, reason: 'no more' }), readSaid: async () => ({ ok: true, kind: 'answer', reply: '' }), runCli: async () => ({ code: 0, stdout: '{}' }) });
    },
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  const answers = () => Object.values(gmBet.readFocus(gmBet.focusPath(dirSeen), root)).map(r => `${r.ask} ${r.label}`);
  const post = body => h.call('POST', '/act', { body });
  try {
    await settle();
    const first = (await post({ orb: true })).json.card;
    assert.equal(first.title, list[0].ask);
    // the answer comes back as the next card, but the page never hears it
    const saved = await post({ card_id: first.id, option_id: 'a2' });
    assert.equal(saved.status, 200);
    const next = saved.json.card;
    assert.equal(next.title, list[1].ask);
    // small teams tapped again on the old card: a2 on this question is fewer mistakes
    const stale = await post({ card_id: first.id, option_id: 'a2' });
    assert.deepEqual([stale.status, stale.json.reason, stale.json.card.id], [409, 'gone', next.id]);
    // a post that names no card does nothing either
    assert.equal((await post({ option_id: 'a2' })).json.reason, 'gone');
    // words said on the old card are not read as an answer to this one
    const said = await post({ card_id: first.id, text: 'fewer mistakes' });
    assert.deepEqual([said.status, said.json.reason], [409, 'gone']);
    assert.deepEqual(answers(), ['who uses the phone page most? small teams']);
    // the card on screen still takes its answer
    const right = await post({ card_id: next.id, option_id: 'a1' });
    assert.equal(right.status, 200);
    assert.deepEqual(answers(), ['who uses the phone page most? small teams', 'what would make a small team pay? saving them hours']);
  } finally {
    await h.close();
  }
});

test('browser: the team table at phone and laptop size: five divided columns, nothing squashed, sideways scroll only on the phone, and a tap and Esc still work', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  for (const viewport of [trace.PHONE, trace.LAPTOP]) {
    const out = await trace.teamTableTrace({ chromePath: CHROME, viewport });
    const at = out.viewport;
    const look = out.look;
    assert.ok(look, `${at}: the table shows`);
    assert.deepEqual(look.heads, ['member', 'role', 'ovr', 'engine', 'status'], at);
    assert.equal(look.rows, 5, at);
    // a line between every pair of columns and every pair of rows
    assert.deepEqual([look.lines.missing_right, look.lines.missing_bottom], [0, 0], at);
    assert.deepEqual([look.lines.inner_right, look.lines.inner_bottom], [20, 20], at);
    // no words spill out of a cell, and names, ratings, and models stay on one line
    assert.deepEqual(look.spills, [], at);
    assert.deepEqual(look.wrapped, [], at);
    assert.ok(look.narrowest.status >= 250, `${at}: the status column keeps its width (${look.narrowest.status}px)`);
    assert.ok(look.narrowest.role >= 140, `${at}: the role column keeps its width (${look.narrowest.role}px)`);
    // the page itself never scrolls sideways; only the table box does, and only on the phone
    assert.equal(look.page_scrolls_sideways, false, at);
    assert.equal(look.scrolls_sideways, at === '390x844', at);
    assert.equal(look.name_column_moved_px, 0, `${at}: the name column stays put`);
    assert.ok(look.smallest_font_px >= 17, at);
    assert.deepEqual(look.moving, [], `${at}: nothing on the table moves or glows`);
    assert.ok(look.statuses.every(t => t === t.toLowerCase()), at);
    // a tap on a row opens that member's talk card; Esc goes back to the team, then to the first card
    assert.deepEqual([out.talk.kind, out.talk.title, out.talk.table], ['member', 'builder', false], at);
    assert.deepEqual([out.back.kind, out.back.table], ['team', true], at);
    assert.equal(out.closed.kind, 'idea', at);
    // on a phone every move around the team pages is one turn in place, not the spiral;
    // on a laptop a move between a wide table card and a plain card still goes through the sphere
    const turn = at === '390x844';
    for (const m of [out.talk.moved, out.back.moved, out.closed.moved]) assert.equal(m.plan === 'hold 150, turn 420', turn, `${at}: ${m.plan}`);
  }
});

test('browser: a tap on an engine cell opens the swap card: the short list, more models on the same card, who it is for, and one tap swaps and brings the team back', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  for (const viewport of [trace.PHONE, trace.LAPTOP]) {
    const out = await trace.engineCardTrace({ chromePath: CHROME, viewport });
    const at = out.viewport;
    // the list as the roster gives it: the Atris model, the pick, more models, who it is for, and the way back
    assert.deepEqual(out.short.buttons, ['atris fastatris', 'm-onenow', 'more models', 'only builder', 'everyone doing builder\'s kind of work', 'back to the team'], at);
    // more models: a new card with every model, and each model keeps its own option id
    assert.notEqual(out.full.card, out.id, at);
    assert.deepEqual(out.full.buttons.slice(0, 3), ['atris fastatris', 'm-onenow', 'm-twotool two, 2 of 2 landed'], at);
    assert.deepEqual(out.full.options.slice(0, 2), out.short.options.slice(0, 2), at);
    // the models already shown stay exactly where they were; the new ones come in under them
    assert.ok(out.kept_moved_px <= 0.5, `${at}: shown models moved ${out.kept_moved_px}px`);
    // who the swap is for: the one set now reads in full color over an amber line, the other stays quiet, and a tap moves it
    for (const [now, set, other] of [[out.scopes.short, 'scope:member', 'scope:job'], [out.scopes.scoped, 'scope:job', 'scope:member']]) {
      assert.deepEqual([now[set].chosen, now[set].line, now[other].chosen], [true, 'rgb(255, 140, 66)', false], `${at}: ${JSON.stringify(now)}`);
      assert.notEqual(now[set].color, now[other].color, at);
      assert.notEqual(now[other].line, 'rgb(255, 140, 66)', at);
    }
    assert.ok(!out.full.options.includes('more'), at);
    // one tap, no yes card: the swap goes to the desk with who it is for, and the team comes back with one line
    assert.deepEqual(out.swaps, [{ member: 'builder', engine: 'two', model: 'm-two', scope: 'job' }], at);
    assert.deepEqual([out.after.kind, out.after.said], ['team', 'builder now runs on two m-two.'], at);
    assert.equal(out.engine, 'two m-two', at);
    // on a phone the swap card opens, and the team comes back after a swap, in one turn in place
    if (at === '390x844') assert.deepEqual([out.opened.plan, out.swapped.plan], ['hold 150, turn 420', 'hold 150, turn 420'], at);
    // the line about the swap is the first thing under the title, above the table, on screen, and said once
    assert.deepEqual([out.news.under_title, out.news.above_table, out.news.bottom <= out.news.screen], [true, true, true], `${at}: ${JSON.stringify(out.news)}`);
    assert.ok(!/\bline\b/.test(out.swapped.plan), `${at}: no line under the orb first (${out.swapped.plan})`);
  }
});

test('browser: the job deck flips one card at a time in the same spot, a yes sends what its card binds, and Esc goes back to the whole team', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const out = await trace.deckTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  assert.deepEqual([out.first.kind, out.first.title], ['deck', 'navigator wants to publish the pricing page'], show);
  // previous and next sit at the top beside the count, the answers and the way back below
  assert.deepEqual(out.first.buttons, ['previous', 'next', 'yes', 'no', 'not now', 'the whole team', 'talk to navigator'], show);
  assert.deepEqual(out.counts, ['2 of 3', '3 of 3', '1 of 3', '3 of 3'], show);
  // on every card, with or without a yes, previous and next are in the same spot, so a thumb never chases them
  for (const at of out.pager) assert.deepEqual(at, out.pager[0], `previous and next stay put: ${JSON.stringify(out.pager)}`);
  assert.equal(out.pager[0][0].y, out.pager[0][1].y, 'previous and next share one line');
  assert.ok(out.moved_px <= 1, `the card stays in one spot (${out.moved_px}px)`);
  assert.equal(out.ghost_seen, true, 'a flip is the turn in place');
  assert.equal(out.swiped, '1 of 3', 'a sideways swipe flips');
  assert.equal(out.scrolled, '1 of 3', 'an up and down swipe does not flip');
  assert.equal(out.typing_arrow, '1 of 3', 'the arrows type while the box has the cursor');
  // one tap arms only this card's yes; a flip draws a fresh card, so nothing is left armed
  const yesOf = buttons => buttons.find(t => t === 'yes' || t === 'tap again to say yes');
  assert.equal(yesOf(out.armed_a), 'tap again to say yes', show);
  assert.equal(yesOf(out.fresh_b), 'yes', show);
  assert.equal(yesOf(out.fresh_a), 'yes', show);
  // the yes sends the job and the hash its card binds, once
  assert.deepEqual(out.yes_sent, [{ job: 'm-nav', key: 'm-nav:step-2:abc', hash: 'abc' }], show);
  assert.equal(out.yes_line, 'navigator: got your yes');
  assert.deepEqual(out.moving, []);
  assert.equal(out.back.kind, 'team', show);
});

test('browser: after a lost answer, a tap on the old card does nothing and the page shows the card the Mac has, with one line why', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.staleAnswerTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  // the answer saved and the desk moved on, but the page never heard: the old card is back with a plain line
  assert.equal(out.after_lost.title, 'who uses the phone page most?', show);
  assert.equal(out.after_lost.line, 'that did not go through. try again.', show);
  // both taps name the card the owner saw
  assert.deepEqual(out.posts, [{ card: 'question:q1', option: 'a2' }, { card: 'question:q1', option: 'a2' }], show);
  // only the answer to the question on screen is saved; fewer mistakes never is
  assert.deepEqual(out.saved, [{ question: 'who uses the phone page most?', answer: 'small teams' }], show);
  // the second tap is refused, and the page lands on the card the Mac has, saying so
  assert.equal(out.at_end.title, 'what would make a small team pay?', show);
  assert.equal(out.at_end.line, 'that card changed, so nothing was done. here is the one on screen now', show);
});

// ---- words that did not send stay in the box ----------------------------------------

test('browser: say something that does not send comes back on its card with the words and the cursor in the box, and Enter tries again', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.unsentSayTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  const kept = { kind: 'idea', title: 'Write a getting started page for the phone', field_open: true, words: out.words, typing: true };
  const pick = l => ({ kind: l.kind, title: l.title, field_open: l.field_open, words: l.words, typing: l.typing });
  // the network is off: the card comes back, the words and the cursor in its box, and a line says so
  assert.deepEqual(pick(out.offline), kept, show);
  assert.equal(out.offline.line, 'that did not reach the mac. try again.', show);
  // Enter again reaches the desk, which could not pass it on: the same, with why
  assert.deepEqual(pick(out.refused), kept, show);
  assert.equal(out.refused.line, 'it did not reach them. try again in a minute.', show);
  // Enter once more goes through: the next card
  assert.equal(out.sent.title, 'Record a two minute demo video', show);
  // the desk got the same words twice
  assert.deepEqual(out.calls, [{ action: 'say', text: out.words }, { action: 'say', text: out.words }], show);
});

// ---- an explanation keeps the card's own answer ------------------------------------

test('browser: what do you mean on a do it or a yes card: the reply explains, so the card\'s own button is on it once and still works', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const runs = await trace.replyKeepsActionTrace({ chromePath: CHROME });
  const show = JSON.stringify(runs, null, 1);
  for (const r of runs) {
    const buttons = r.after_reply.buttons;
    // the card's own button once, the answers the reply adds, and the box
    for (const b of [r.label, 'sounds good', 'make it shorter', 'or say something']) assert.equal(buttons.filter(x => x === b).length, 1, `${r.card}: ${b}: ${show}`);
    // two taps on it act on that card
    assert.equal(r.error, null, show);
    assert.deepEqual(r.did, [r.label === 'do it' ? 'do' : 'yes'], show);
  }
  // the yes card keeps its no and not now
  assert.ok(['no', 'not now'].every(b => runs[1].after_reply.buttons.includes(b)), show);
});

// ---- a send that went through is never sent twice -----------------------------------

test('over http: a typed send carries its own id; a repeat of one that went through gets the first answer and sends nothing', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const steers = [];
  let fail = false;
  let desk = null;
  const h = await startHandler({
    makeBetDesk: (log, dir) => {
      desk = gmBet.createBetDesk({
        workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, warmOnCreate: false,
        readTeam: () => [{ name: 'builder' }], readMissions: () => ({}), readHandoffs: () => [],
        loadSeason: () => ({ outcomes: [], error: null }), resolveEngine: () => ({ engine: { id: 'one' }, model: 'm-one' }),
        generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}),
        readSaid: async () => ({ ok: true, kind: 'instruction', reply: '' }),
        runCli: async (args) => { steers.push(String(args[args.length - 1]).replace(/^the owner says: /, '')); return fail ? { code: 1, stdout: '{}' } : { code: 0, stdout: JSON.stringify({ action: 'member_steered' }) }; },
      });
      return desk;
    },
  });
  // the finished job on screen, served fresh: a word to its member moves on to the next card
  const onDone = async () => {
    desk.state.status = 'ready';
    desk.state.current = { kind: 'done', id: 'done:intro', job: { owner: 'builder', title: 'Write the intro', bet: { expect: 'more people finish setup.' } } };
    return (await h.call('GET', '/card')).json.card.id;
  };
  const say = body => h.call('POST', '/act', { body });
  try {
    const id = await onDone();
    assert.match(id, /^done:intro#[0-9a-f]{8}$/);
    // it reaches builder; the answer is lost and the phone sends the same words, same id
    const first = await say({ card_id: id, text: 'add the short demo too', send: 'k1a2b3c4' });
    assert.deepEqual([first.status, first.json.ack], [200, 'sent to builder.']);
    const again = await say({ card_id: id, text: 'add the short demo too', send: 'k1a2b3c4' });
    assert.deepEqual([again.status, again.json], [200, first.json]);
    assert.deepEqual(steers, ['add the short demo too'], 'builder heard it once');
    // new words are a new send
    assert.equal((await say({ card_id: await onDone(), text: 'and the twelve schools', send: 'k9z8y7x6' })).status, 200);
    assert.deepEqual(steers, ['add the short demo too', 'and the twelve schools']);
    // a send that did nothing is tried again on a retry with the same id
    fail = true;
    const card = await onDone();
    assert.equal((await say({ card_id: card, text: 'one more thing', send: 'm5n6o7p8' })).json.ok, false);
    fail = false;
    assert.equal((await say({ card_id: card, text: 'one more thing', send: 'm5n6o7p8' })).json.ack, 'sent to builder.');
    assert.deepEqual(steers.slice(2), ['one more thing', 'one more thing'], 'the failed one, then the retry that went through');
  } finally {
    await h.close();
  }
});

test('browser: a send whose answer was lost goes again with the same id and reaches the desk once; new words get a new id', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.lostReplyTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  // the answer was lost: the words came back in the box for Enter
  assert.equal(out.kept, out.words, show);
  assert.equal(out.posts.length, 3, show);
  const [first, retry, fresh] = out.posts;
  assert.match(String(first.send), /^[a-z0-9]{8,32}$/, show);
  assert.equal(retry.send, first.send, show);
  assert.notEqual(fresh.send, first.send, show);
  // the desk took each set of words once
  assert.deepEqual(out.took, [out.words, out.new_words], show);
});

// ---- a word to a teammate that did not send comes back, ready to send again ----------

test('browser: a word to a teammate that did not send comes back in its box, a line says so, and a retry reaches them once', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.talkFailTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  for (const l of [out.offline, out.lost]) {
    // nothing left the phone, or the answer was lost: the talk card, the words in its box, one line
    assert.deepEqual([l.kind, l.field_open, l.words, l.typing, l.line], ['member', true, out.words, true, 'that did not reach the mac. try again.'], show);
  }
  // Enter once more: the first answer comes back, and builder is not told twice
  assert.equal(out.sent.said, 'builder has it.', show);
  assert.deepEqual(out.took, [out.words], show);
  // every try of the same words carried the same id
  assert.equal(out.posts.length, 3, show);
  assert.match(String(out.posts[0].send), /^[a-z0-9]{8,32}$/, show);
  for (const post of out.posts) assert.deepEqual([post.text, post.send], [out.words, out.posts[0].send], show);
});

// ---- a start that did not get going comes back to do it ----------------------------

test('browser: after an explanation, a do it that did not get going comes back with do it and one line, and a retry starts', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.startFailTrace({ chromePath: CHROME });
  const show = JSON.stringify(out, null, 1);
  // never stuck: the card it was on is back, do it and all, with why
  assert.ok(out.failed.buttons.includes('do it'), show);
  assert.equal(out.failed.line, 'it did not get going. try again in a minute.', show);
  // two taps on do it again reach the desk again, and who has it shows under the orb before the next card
  assert.equal(out.error, null, show);
  assert.equal(out.starts, 2, show);
  assert.equal(out.under, 'builder has it and is starting now.', show);
});

// ---- the small orb on a card goes back to the big one ------------------------------

test('browser: the same words to two members are two sends, and each member hears them', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const out = await trace.twoMembersTrace({ chromePath: CHROME });
  assert.deepEqual(out.took, [{ member: 'builder', text: 'pause this' }, { member: 'launcher', text: 'pause this' }], JSON.stringify(out));
});

test('browser: the small orb on any card goes back to the big dotted orb; the big one brings the next, and an idea that landed meanwhile waits for that tap', { skip: !CHROME && 'no chrome on this machine', timeout: 90000 }, async () => {
  const runs = await trace.orbHomeTrace({ chromePath: CHROME });
  const show = JSON.stringify(runs, null, 1);
  const [idea, calm, yes] = runs;
  assert.equal(runs.length, 3, show);
  for (const r of runs) {
    // the card goes, the big orb is back with its line, and nothing new was asked for
    assert.deepEqual(r.home, { has_card: false, big_orb: true, line: 'tap to think', title: null, asked: 0 }, show);
  }
  // from an idea and from a yes card: the big orb's tap asks for the next card, the same as on page open
  for (const r of [idea, yes]) assert.deepEqual([r.tapped.has_card, r.tapped.title, r.tapped.asked], [true, 'Record a two minute demo video', 1], show);
  // from the calm line: the idea that landed waits on the big orb, then the tap brings that idea, not one past it
  assert.deepEqual([calm.stayed.has_card, calm.stayed.asked], [false, 0], show);
  assert.deepEqual([calm.tapped.has_card, calm.tapped.title, calm.tapped.asked], [true, 'Write a getting started page for the phone', 1], show);
});

// ---- typing on the calm line: the idea waits for the owner -------------------------

test('browser: on the calm line the owner types, the idea lands and waits; words sent there are a note, and the idea that comes in is the one written with it; a cleared box lets the waiting idea in', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const gmBet = require('../lib/gm-bet');
  const idea = (title) => ({
    title,
    why_now: 'installs last week were 1,400 and the phone page just went live, so new installs have nothing to try first.',
    expect: '300 more npm installs in the week before nov 1',
    target: { metric: 'installs', baseline: 1400, goal: 1700 },
    check_in_days: 9, metric_source: 'npm installs for atris', verify: 'test -s docs/gm-phone.md', cost: 'about 4 hours of agent time, $0',
    steps: [{ text: 'draft the getting started page', who: 'team', member: 'builder', public: false }],
  });
  const IDEA = idea('Write a getting started page for atris gm phone with a 30 second screen recording');
  const NOTED = idea('Write a getting started page for schools that try atris gm phone in class');
  const WORDS = 'make it about schools';
  const FOLDED = 'got it, i\'ll fold that in.';
  const runs = [];
  for (const end of ['send', 'clear']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
    const writing = [];
    const said = [];
    const desk = gmBet.createBetDesk({
      workspaceRoot: root, ledgerFile: path.join(root, 'gm-bets.jsonl'), log: () => {}, warmOnCreate: false, choices: false,
      readTeam: () => [{ name: 'builder' }], readMissions: () => ({}), readHandoffs: () => [],
      // like the real writer, a drafting the desk stops ends at once
      generate: o => new Promise((resolve) => { const w = { o, resolve, stopped: false }; writing.push(w); if (o.signal) o.signal.addEventListener('abort', () => { w.stopped = true; resolve({ ok: false, stopped: true }); }); }),
      generateQuestion: () => new Promise(() => {}),
      readSaid: async (p) => { said.push(p); return { ok: true, kind: 'instruction', reply: '' }; },
      runCli: async () => ({ code: 0, stdout: '{}' }),
    });
    // the one generic question is answered, so a tap with nothing ready is the calm line
    desk.next();
    desk.answer({ choice: 'money' });
    assert.equal(desk.next().kind, 'wait');
    // the drafting that began before the answer stopped, and a fresh one knows it
    await new Promise(r => setImmediate(r));
    assert.equal(writing.length, 2);
    runs.push(await trace.onPhone(desk, CHROME, async (p) => {
      const look = () => p.run("(function () { var i = document.querySelector('#bet .field input'); return { title: document.querySelector('#bet h1').textContent, words: i ? i.value : null, notes: Array.prototype.map.call(document.querySelectorAll('#bet .waitnotes .turn'), function (n) { return n.textContent; }), dots: document.getElementById('orb').__orb.frame }; })()");
      const calm = await look();
      // the box is open already; a tap puts the cursor in it
      await p.tap('#bet .sayline .field input');
      await new Promise(r => setTimeout(r, 250));
      await p.type(WORDS);
      // the idea is written while the owner types
      writing[writing.length - 1].resolve({ ok: true, bet: IDEA });
      await new Promise(r => setTimeout(r, 3500));
      const typing = await look();
      const out = { end, calm, typing };
      if (end === 'send') {
        await p.enter();
        await p.until(`Array.prototype.some.call(document.querySelectorAll('#bet .waitnotes .turn'), function (n) { return n.textContent === ${JSON.stringify(FOLDED)}; })`, 'the note folded in', 6000);
        await new Promise(r => setTimeout(r, 300));
        out.folded = await look();
        // the drafting no one asked for is stopped for the note, and one with the note starts;
        // the idea that landed before it waits behind the calm line
        const noted = () => writing.find(w => !w.stopped && w.o.ownerNote);
        for (let i = 0; i < 100 && !noted(); i += 1) await new Promise(r => setTimeout(r, 20));
        out.stopped = writing.filter(w => w.stopped).length;
        await new Promise(r => setTimeout(r, 3200));
        out.held = await look();
        // the idea written with the note is the one that comes in
        out.note = noted().o.ownerNote;
        noted().resolve({ ok: true, bet: NOTED });
      } else await p.run("(function () { var i = document.querySelector('#bet .field input'); if (i) { i.value = ''; i.blur(); } })()");
      await p.until(`document.querySelector('#bet h1').textContent === ${JSON.stringify(end === 'send' ? NOTED.title : IDEA.title)}`, 'the idea', 9000).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      return { ...out, after: await look(), said: said.length };
    }));
  }
  const show = JSON.stringify(runs, null, 1);
  for (const r of runs) {
    assert.equal(r.calm.title, 'writing your next idea.', show);
    assert.equal(r.calm.words, '', 'the calm line opens with its box open');
    // the idea landed while the owner typed: the words and the calm line stay
    assert.deepEqual([r.typing.title, r.typing.words], ['writing your next idea.', WORDS], show);
    assert.ok(r.typing.dots - r.calm.dots > 60, `the dots kept moving the whole time: ${show}`);
  }
  const [sent, cleared] = runs;
  // sent: a note, read by no model; the box is open again and empty, the card says it is folded in
  assert.deepEqual([sent.folded.title, sent.folded.words, sent.folded.notes], ['writing your next idea.', '', [WORDS, FOLDED]], show);
  assert.equal(sent.said, 0, show);
  // the drafting no one asked for stopped for it; the idea written without it waits,
  // and the one written with it comes in
  assert.ok(sent.stopped >= 2, show);
  assert.equal(sent.held.title, 'writing your next idea.', show);
  assert.equal(sent.note, WORDS, show);
  assert.equal(sent.after.title, NOTED.title, show);
  // cleared and left: the idea that landed comes in
  assert.equal(cleared.after.title, IDEA.title, show);
});

// ---- the wait, frame by frame: no frozen moment and no jump ------------------------------

test('browser: after a typed answer the dots never stop: got it, the calm line with its box open, a note folded in, and the idea grows out of the dots, with no frozen moment and no jump', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const r = await trace.waitTrace({ chromePath: CHROME });
  const show = JSON.stringify(r, null, 1);
  assert.equal(r.reached_idea, true, show);
  // the only still moment is the beat the chosen answer holds; while the owner waits, never
  assert.ok(r.longest_still_ms <= 250, show);
  assert.ok(r.longest_still_waiting_ms <= 150, show);
  // the dots move through the wait: 200 frames at 60fps, as time, so a slower machine reads the same
  assert.ok(r.dots_moving_ms > 200 * 16.7, show);
  // the got it line under the moving sphere, then the calm line's live words, its open box, the note
  assert.ok(r.lines.includes('got it: paying schools.'), show);
  assert.equal(r.calm_box_open, true, show);
  assert.ok(r.calm_steps.length >= 2 && r.calm_steps.every(x => trace.CALM_LINES.includes(x)), show);
  assert.deepEqual(r.calm_notes, ['make it about schools', 'got it, i\'ll fold that in.'], show);
  // the note is a post on the calm line's own id, and the idea comes when asked for from it
  assert.deepEqual(r.posts.map(x => [x.action, x.card]), [['say', 'question:focus'], ['say', 'wait:7'], ['orb', 'wait:7']], show);
  // no jump: nothing leaps in a frame or changes speed in one (per 60fps frame, css pixels,
  // read on the clock each part moves by, so a slower machine reads the same)
  assert.ok(r.lava_max_step_px <= 45, show);
  assert.ok(r.lava_max_size_step_px <= 45, show);
  assert.ok(r.lava_max_speed_change_px <= 15, show);
  assert.ok(r.sphere_max_step_px <= 10, show);
  assert.ok(r.dots_max_speed_change_px <= 10, show);
  assert.ok(r.title_max_step_px <= 5, show);
  assert.equal(r.footer_seen_jump_px, 0, show);
  // the idea is born where the dots were
  assert.ok(r.bloom_from_dots_px <= 3, show);
});

test('trace: a few stalls cannot hide a jump in the wait, and a slow machine reads the same as a fast one', () => {
  // 120 frames of the lava gliding 2px per 60fps frame; the last one is the idea at rest
  const lavaRun = (gap, stalls = [], jump = -1) => {
    const frames = [];
    let ft = 0, x = 0;
    for (let i = 0; i < 120; i++) {
      const ms = stalls.includes(i) ? 300 : gap;
      ft += ms;
      x += i === jump ? 180 : 2 * ms / 16.7;
      frames.push({ t: ft, ft, orb: null, pix: null, sphere: false, stage: null, lava: { r: { x, y: 300, w: 56, h: 56 }, o: 1, at: ft }, box: { o: 1, kind: 'wait', card: 'wait:7', title: { x: 20, y: 100, w: 300, h: 40 }, titleText: i === 119 ? 'the idea' : 'the calm line' }, waiting: true, field: true, fieldRect: null, step: '', notes: [], line: '', lineO: 1, foot: { r: { x: 0, y: 800, w: 390, h: 20 }, o: 1 }, busy: false });
    }
    return trace.summarizeWait(frames, 0, 'the idea');
  };
  // four 300ms stalls in a 60fps run leave its pace alone, so a 180px jump in one is a jump
  const stalled = lavaRun(16.7, [20, 40, 60, 80], 60);
  assert.equal(stalled.pace_frame_ms, 17);
  assert.equal(stalled.stall_frame_ms, 50);
  assert.ok(stalled.lava_max_step_px > 45, JSON.stringify(stalled));
  // a machine whose every frame takes 120ms reads the same glide as a 60fps one
  const slow = lavaRun(120);
  assert.equal(slow.stall_frame_ms, 240);
  assert.ok(Math.abs(slow.lava_max_step_px - 2) < 0.1 && slow.lava_max_speed_change_px < 0.1, JSON.stringify(slow));
  // and no stall is ever longer than a quarter second, however slow the machine
  assert.equal(lavaRun(200).stall_frame_ms, 250);
});

test('browser: the calm line fits every screen: its box is inside the edges with send whole, and its words are centered under the sphere with the team, at 390, 430, and laptop width', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const runs = await trace.calmLayoutTrace({ chromePath: CHROME });
  const show = JSON.stringify(runs, null, 1);
  assert.deepEqual(runs.map(r => r.viewport), ['390x844', '430x932', '1280x800']);
  for (const r of runs) {
    // nothing runs off the side, and the page never scrolls sideways
    assert.equal(r.scroll_w, r.vw, show);
    assert.ok(r.field.left >= 16 && r.field.right <= r.vw - 16, show);
    assert.ok(r.send.right <= r.field.right && r.send.left >= r.field.left, show);
    // the card lines up with every other card: the same column, centered
    assert.ok(Math.abs((r.card.left + r.card.right) / 2 - r.vw / 2) <= 1, show);
    assert.ok(Math.abs(r.title.mid - r.team.mid) <= 4, show);
    assert.ok(Math.abs(r.title.mid - r.vw / 2) <= 4, show);
    // the box sits above the footer
    assert.ok(r.field.bottom < r.foot.top, show);
  }
});

test('browser: under reduced motion the same wait has no swarm and no travel, only plain fades, and the calm line still takes a note',{ skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const r = await trace.waitTrace({ chromePath: CHROME, reduced: true });
  const show = JSON.stringify(r, null, 1);
  assert.equal(r.reached_idea, true, show);
  // the dots are drawn when the sphere changes, and hold: a redraw or two, never a swarm
  assert.ok(r.orb_frames_drawn <= 6, show);
  assert.ok(r.dot_frames <= 2, show);
  // nothing travels: not the lava, not the sphere, not the footer
  assert.deepEqual([r.lava_max_step_px, r.sphere_max_step_px, r.footer_seen_jump_px], [0, 0, 0], show);
  // every card change is a fade
  assert.ok(r.fading_frames >= 6, show);
  assert.equal(r.calm_box_open, true, show);
  assert.deepEqual(r.calm_notes, ['make it about schools', 'got it, i\'ll fold that in.'], show);
});

// ---- the number question and the weekly number card read first ---------------------

test('over http: "what" typed into something else on the number question is read first: explained, nothing saved; a real name is saved', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  let reading = { ok: true, kind: 'unclear', reply: 'i am asking which number tells you this project is going well, like weekly installs or paying schools.' };
  let dirSeen = null;
  const h = await startHandler({
    makeBetDesk: (log, dir) => { dirSeen = dir; return gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, scoreboard: true, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readSaid: async () => reading, runCli: async () => ({ code: 0, stdout: '{}' }) }); },
  });
  const board = () => gmBet.readScoreboard(gmBet.scoreboardPath(dirSeen), root);
  const post = body => h.call('POST', '/act', { body });
  try {
    const q = (await post({ orb: true })).json.card;
    assert.equal(q.title, 'what number tells you this is going well?');
    // the owner was confused and typed "what" into something else, exactly as it happened
    const what = await post({ card_id: q.id, option_id: 'other', text: 'what' });
    assert.deepEqual([what.status, what.json.card.kind, what.json.card.title], [200, 'reply', reading.reply]);
    assert.equal(board(), null, 'nothing was saved as the number');
    // the reply only explains, so the question's own answers are on it once, something else too
    assert.deepEqual(what.json.card.options.map(o => o.label), q.options.map(o => o.label));
    reading = { ok: true, kind: 'answer', reply: '' };
    const named = await post({ card_id: what.json.card.id, option_id: 'other', text: 'paying schools' });
    assert.equal(named.json.ack, 'got it: paying schools.');
    assert.equal(board().name, 'paying schools');
  } finally {
    await h.close();
  }
});

// ---- the card is the conversation -------------------------------------------------

test('browser: a two-turn chat on the number question: one place to type, the turns kept, the choices once, the sphere while it is read, a long reply at body size, and the owner is you', { skip: !CHROME && 'no chrome on this machine', timeout: 120000 }, async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const LONG = "I'm asking which number would tell you the overnight work is going well. Pick one of the four buttons, or tell me another number you'd watch.";
  const seen = [];
  const desk = gmBet.createBetDesk({
    workspaceRoot: root, ledgerFile: path.join(root, 'gm-bets.jsonl'), log: () => {}, warmOnCreate: false, choices: false, scoreboard: true, ownerName: 'Keshav',
    generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}),
    suggestScoreboard: async () => ({ ok: true, choices: [{ name: 'weekly installs', up: true }, { name: 'first runs that finished a recap', up: true }, { name: 'overnight changes Keshav redid', up: false }] }),
    // a slow reader that, like the live one, offers the card's own choices back
    readSaid: async (opts) => {
      seen.push(opts.thread.map(t => t.text));
      await new Promise(r => setTimeout(r, 1500));
      return { ok: true, kind: 'question', reply: LONG, suggestions: ['weekly installs', 'first runs that finished a recap', 'overnight changes you redid', 'paying schools'] };
    },
    runCli: async () => ({ code: 0, stdout: '{}' }),
  });
  desk.warm();
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(desk.next().id, 'question:scoreboard');
  const out = await trace.onPhone(desk, CHROME, async (p) => {
    const look = () => p.run(`(function () {
      var box = document.getElementById('bet'), h = box.querySelector('h1');
      return {
        has_card: document.body.classList.contains('has-card') && !box.hidden,
        title: h.textContent, title_top: Math.round(h.getBoundingClientRect().top), title_px: getComputedStyle(h).fontSize,
        buttons: Array.prototype.map.call(box.querySelectorAll('button'), function (b) { return b.textContent; }),
        // something else (or the box it becomes while it is read), or the say line
        places_to_type: box.querySelectorAll('.other, .act .field, .sayline').length,
        ellipses: (box.innerText.match(/\\u2026/g) || []).length,
      };
    })()`);
    const chat = async (words) => {
      await p.run("Array.prototype.find.call(document.querySelectorAll('#bet button'), function (b) { return b.textContent === 'something else'; }).click()");
      await new Promise(r => setTimeout(r, 300));
      await p.type(words);
      await p.enter();
      await new Promise(r => setTimeout(r, 700));
      const loading = await look();
      await p.until(`document.querySelector('#bet h1').textContent === ${JSON.stringify(LONG)} && !document.body.hasAttribute('data-busy') && document.body.classList.contains('has-card')`, 'the reply', 8000);
      await new Promise(r => setTimeout(r, 300));
      return { loading, reply: await look() };
    };
    const before = await look();
    const one = await chat('what');
    const two = await chat('which one is best?');
    return { before, one, two, why_px: await p.run("(function () { var n = document.createElement('p'); n.className = 'why'; document.getElementById('bet').appendChild(n); var px = getComputedStyle(n).fontSize; n.remove(); return px; })()") };
  });
  const show = JSON.stringify({ out, seen }, null, 1);
  // the owner is you, in the choices and everywhere on the card
  assert.ok(out.before.buttons.includes('overnight changes you redid'), show);
  for (const state of [out.before, out.one.reply, out.two.reply]) {
    assert.ok(!state.buttons.some(b => /keshav/i.test(b)), show);
    // one place to type, always: something else on a question card
    assert.equal(state.places_to_type, 1, show);
  }
  for (const turn of [out.one, out.two]) {
    // while the reply is read the card has gone into the sphere: no ellipsis, no thinking words
    assert.equal(turn.loading.has_card, false, show);
    assert.equal(turn.loading.ellipses, 0, show);
    // the choices once, then only the new suggestion
    assert.deepEqual(turn.reply.buttons, ['weekly installs', 'first runs that finished a recap', 'overnight changes you redid', 'something else', 'paying schools'], show);
    // a long reply sits in the title's spot at the body size
    assert.equal(turn.reply.title_top, out.before.title_top, show);
    assert.equal(turn.reply.title_px, out.why_px, show);
  }
  // the second turn continues the same conversation
  assert.deepEqual(seen, [[], ['what', LONG]], show);
});

test('trace: chrome gets time to start on a cold, busy runner, still well inside each browser test', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gm-phone-trace.js'), 'utf8');
  const wait = Number(/const CHROME_START_MS = (\d+);/.exec(src)[1]);
  // The first launch in a CI shard took over 15s and failed tests that had 90s.
  assert.ok(wait >= 45000, `chrome start wait ${wait}ms`);
  assert.ok(wait <= 60000, `chrome start wait ${wait}ms leaves the test no time`);
  assert.match(src, /chrome did not start in \$\{CHROME_START_MS \/ 1000\}s/);
});
