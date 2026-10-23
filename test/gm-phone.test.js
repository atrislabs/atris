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
  const call = async (method, p, { body, token = TOKEN, header = true, origin = `http://${base}` } = {}) => {
    const headers = {};
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

test('over http: an empty queue tap gets a question at once; the answer is saved through /bet/answer', async () => {
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
  try {
    assert.equal(calls.length, 1, 'the desk warms as soon as the server makes it');
    const started = Date.now();
    const tap = await h.call('POST', '/bet/think', { body: {} });
    assert.ok(Date.now() - started < 1000);
    assert.equal(tap.status, 200);
    assert.equal(tap.json.kind, 'question');
    assert.equal(tap.json.question.choices.length, 3);
    // two parts: the question, and what is going on with why the answer matters
    assert.deepEqual(Object.keys(tap.json.question), ['ask', 'line', 'choices']);
    assert.equal(tap.json.question.line, 'installs dropped to 1,511 last week, down from 1,640.');
    assert.equal(tap.json.question.ask, 'what matters most for this project this month?');
    // same token, origin, and json checks as every other post
    assert.equal((await h.call('POST', '/bet/answer', { token: 'nope', body: { choice: 'money' } })).status, 403);
    assert.equal((await h.call('POST', '/bet/answer', { origin: 'http://evil.example', body: { choice: 'money' } })).status, 403);
    assert.equal((await h.call('POST', '/bet/answer', { body: { choice: 'nope' } })).json.reason, 'bad_choice');
    const answered = await h.call('POST', '/bet/answer', { body: { choice: 'money' } });
    assert.equal(answered.status, 200);
    assert.equal(answered.json.ack, 'got it: making money from it.');
    assert.equal(gmBet.readFocus(gmBet.focusPath(path.dirname(ledgerFile)), root).focus.label, 'making money from it');
    assert.equal((await h.call('POST', '/bet/answer', { body: { choice: 'money' } })).status, 409, 'nothing on screen to answer now');
    assert.equal(calls.length, 1, 'still the one generation in the background');
  } finally {
    await h.close();
  }
});

test('over http: a choice card picks through /bet/pick with the same checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const titles = ['Write a getting started page for the phone', 'Record a two minute demo video for the readme'];
  let n = 0;
  const bet = title => ({ title, why_now: 'installs last week were 1,400.', expect: 'more people try it by nov 1.', target: { metric: 'installs', baseline: 1400, goal: 1700 }, metric_source: 'npm', verify: 'test -s docs/a.md', cost: 'about 2 hours', check_date: '2026-10-30', steps: [{ text: 'draft it', who: 'team', member: 'builder', public: false }, { text: 'publish it', who: 'you', public: true }] });
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, readTeam: () => null, generate: () => Promise.resolve(n < 2 ? { ok: true, bet: bet(titles[n++]) } : new Promise(() => {})), generateQuestion: () => new Promise(() => {}), runCli: async () => ({ code: 0, stdout: '{}' }) }),
  });
  try {
    await new Promise(r => setTimeout(r, 30));
    const tap = await h.call('POST', '/bet/think', { body: {} });
    assert.equal(tap.json.kind, 'choice');
    assert.deepEqual(tap.json.choice.options.map(o => o.title), titles);
    assert.equal((await h.call('POST', '/bet/pick', { token: 'nope', body: { id: tap.json.choice.options[0].id } })).status, 403);
    const picked = await h.call('POST', '/bet/pick', { body: { id: tap.json.choice.options[0].id } });
    assert.deepEqual([picked.status, picked.json.kind, picked.json.bet.title], [200, 'bet', titles[0]]);
    assert.equal((await h.call('POST', '/bet/pick', { body: { id: tap.json.choice.options[1].id } })).status, 409);
  } finally {
    await h.close();
  }
});

test('page: a choice card is big titles to tap, each with one plain line of why, and a pick opens the full card', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.match(script, /if \(s\.kind === 'choice'\) \{ drawChoiceCard\(s\); return; \}/);
  assert.match(script, /api\('\/bet\/pick', \{ id: o\.id \}\)\.then\(function \(r\) \{/);
  assert.match(script, /turn\(r\);/);
  assert.match(html, /\.option \.t \{[^}]*font-size: 20px;/);
  assert.match(html, /\.option \.w \{[^}]*font-size: 17px;/);
  assert.match(script, /\(s\.bet \|\| s\.job \|\| s\.question \|\| s\.choice \|\| s\.report\)/);
});

test('page: the team table opens from the footer, one row per member, and a row opens a talk card', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.match(html, /<section class="team" id="team" hidden role="dialog" aria-label="the team">/);
  assert.match(script, /getElementById\('working'\)\.addEventListener\('click', openTeam\)/);
  assert.match(script, /api\('\/bet\/team'\)/);
  // each row: the member, what they are on, the status, and the time
  assert.match(script, /row\.appendChild\(el\('span', 'who', r\.member\)\);/);
  assert.match(script, /row\.appendChild\(el\('span', 'st ' \+ r\.status\.replace\(\/ \/g, '-'\), r\.status\)\);/);
  assert.match(script, /row\.appendChild\(el\('span', 'on', r\.on\)\);/);
  assert.match(script, /row\.appendChild\(el\('span', 'time', r\.time\)\);/);
  // the talk card steers through the server
  assert.match(script, /convo\(function \(body\) \{ body\.member = r\.member; return api\('\/bet\/steer', body\); \}/);
  assert.match(html, /\.team \.row \{[^}]*\}/);
});

test('over http: the team table and a steer go through the same token and json checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\nrole: Builder\n---\n');
  const ran = [];
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readSaid: async () => ({ ok: true, kind: 'instruction', reply: '' }), readMissions: () => new Map([['m1', { id: 'm1', owner: 'builder', status: 'running', objective: 'Write the try page.', created_at: new Date(NOW - 600000).toISOString(), last_tick_at: new Date(NOW - 60000).toISOString(), human_asks: [] }]]), driverAlive: () => true, runCli: async (args) => { ran.push(args); return { code: 0, stdout: '{"ok":true,"action":"member_steered"}' }; } }),
  });
  try {
    assert.equal((await h.call('GET', '/bet/team', { token: 'nope' })).status, 403);
    const team = await h.call('GET', `/bet/team?t=${TOKEN}`);
    assert.deepEqual(team.json.rows, [{ member: 'builder', on: 'Write the try page', status: 'working', time: 'at it for 10 minutes' }]);
    assert.equal((await h.call('POST', '/bet/steer', { token: 'nope', body: { member: 'builder', text: 'hi' } })).status, 403);
    const sent = await h.call('POST', '/bet/steer', { body: { member: 'builder', text: 'readme first' } });
    assert.deepEqual([sent.status, sent.json.ack], [200, 'sent to builder.']);
    assert.deepEqual(ran[0], ['member', 'steer', 'builder', '--no-ignite', '--json', '--', 'the owner says: readme first']);
  } finally {
    await h.close();
  }
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

test('page: every card has a quiet say-something line that opens into one box', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.match(script, /function sayBox\(\) \{/);
  assert.match(script, /var open = el\('button', 'quiet', 'or say something'\);/);
  // on a card the line itself becomes the box, in its own spot
  assert.match(script, /typeHere\(open, 'say something', 280, function \(text, field\) \{ say\(field, \{ text: text \}\); \}\);/);
  // the words hold as chosen while they are read; an answer or an instruction brings the next card
  assert.match(script, /var heldAt = hold\(spot\);\n\s+api\('\/bet\/say', body\)\.catch\(offline\)\.then\(function \(r\) \{\n\s+if \(r\.ok && !r\.stay\) \{ think\(false, heldAt\); return; \}/);
  // a question back takes the title's spot, its suggested replies one tap each where the answers were
  assert.match(script, /box\.appendChild\(el\('h1', null, r\.stay \? r\.reply : \(r\.message \|\| 'that did not go through'\)\)\);/);
  assert.match(script, /if \(r\.stay\) \(r\.suggestions \|\| \[\]\)\.forEach\(function \(sug\) \{ act\.appendChild\(sayChoice\(sug, \{ text: sug \}\)\); \}\);/);
  // starting a member that is not running takes a second tap, or keeps it as a note
  assert.match(script, /act\.appendChild\(sayChoice\('start it', \{ text: said, confirm: true \}\)\);/);
  assert.match(script, /act\.appendChild\(sayChoice\('keep it as a note instead', \{ text: said, note: true \}\)\);/);
  // the talk card with one member keeps its own box: an ellipsis while it reads, the reply in place
  assert.match(script, /input\.maxLength = 280;/);
  assert.match(script, /reply\.textContent = '\u2026';/);
  assert.match(script, /post\(body\)\.then\(function \(r\) \{\n\s+if \(r\.ok && !r\.stay\) \{ done\(r\.ack\); return; \}/);
  // the conversation so far stays on the card, and suggested replies are one tap
  assert.match(script, /drawThread\(r\.thread\.slice\(0, -1\)\);/);
  assert.match(script, /\(r\.suggestions \|\| \[\]\)\.forEach\(function \(sug\) \{/);
  assert.match(script, /if \(r\.stay\) \{ reply\.textContent = r\.reply;/);
  // starting a member that is not running takes a second tap, or keeps it as a note
  assert.match(script, /if \(r\.reason === 'needs_confirm'\) \{/);
  assert.match(script, /el\('button', 'quiet', 'keep it as a note instead'\)/);
  // editing the words clears the armed second tap, and the second tap sends what is in the box now
  assert.match(script, /input\.addEventListener\('input', function \(\) \{ if \(pending\) disarm\(\); \}\);/);
  assert.match(script, /if \(pending\) \{ disarm\(\); go\(\{ confirm: true \}\); return; \}/);
  assert.match(script, /keep\.addEventListener\('click', function \(\) \{ disarm\(\); go\(\{ note: true \}\); \}\);/);
  // on every kind of card
  for (const fn of ['drawBetCard', 'drawJobCard', 'drawQuestionCard', 'drawChoiceCard']) {
    const body = script.slice(script.indexOf(`function ${fn}(`), script.indexOf('\n  }\n', script.indexOf(`function ${fn}(`)));
    assert.match(body, /box\.appendChild\(sayBox\(\)\);/, fn);
  }
});

test('over http: say something goes through the same token and json checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  const h = await startHandler({
    makeBetDesk: (log, dir) => gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), readSaid: async () => ({ ok: true, kind: 'answer', reply: '' }), runCli: async () => ({ code: 0, stdout: '{}' }) }),
  });
  try {
    await h.call('POST', '/bet/think', { body: {} });
    assert.equal((await h.call('POST', '/bet/say', { token: 'nope', body: { text: 'hi' } })).status, 403);
    assert.equal((await h.call('POST', '/bet/say', { origin: 'http://evil.example', body: { text: 'hi' } })).status, 403);
    assert.equal((await h.call('POST', '/bet/say', { body: { text: 'x'.repeat(281) } })).json.reason, 'too_long');
    const ok = await h.call('POST', '/bet/say', { body: { text: 'more people using it, in schools' } });
    assert.deepEqual([ok.status, ok.json.ack], [200, 'got it: more people using it, in schools.']);
  } finally {
    await h.close();
  }
});

test('page: the weekly number card and the something-else answer are one tap each', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  assert.match(script, /if \(s\.kind === 'report'\) \{ drawReportCard\(s\); return; \}/);
  assert.match(script, /input\.type = 'number';/);
  assert.match(script, /api\('\/bet\/report', \{ value: input\.value \}\)/);
  // something else becomes the box in its own spot, and the words are the answer
  assert.match(script, /if \(c\.other\) \{ typeHere\(b, c\.label, 60, function \(text, field\) \{ answer\(field, \{ choice: 'other', text: text \}\); \}\); return; \}/);
  assert.match(script, /\(s\.bet \|\| s\.job \|\| s\.question \|\| s\.choice \|\| s\.report\)/);
});

test('over http: the weekly number goes through /bet/report with the same checks', async () => {
  const gmBet = require('../lib/gm-bet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-phone-ws-'));
  let dirSeen = null;
  const h = await startHandler({
    makeBetDesk: (log, dir) => { dirSeen = dir; return gmBet.createBetDesk({ workspaceRoot: root, ledgerFile: path.join(dir, 'gm-bets.jsonl'), now: () => NOW, log, scoreboard: true, generate: () => new Promise(() => {}), generateQuestion: () => new Promise(() => {}), runCli: async () => ({ code: 0, stdout: '{}' }) }); },
  });
  try {
    const q = await h.call('POST', '/bet/think', { body: {} });
    assert.equal(q.json.question.ask, 'what number tells you this is going well?');
    const named = await h.call('POST', '/bet/answer', { body: { choice: 'other', text: 'paying schools' } });
    assert.equal(named.json.ack, 'got it: paying schools.');
    const r = await h.call('POST', '/bet/think', { body: {} });
    assert.equal(r.json.kind, 'report');
    assert.equal((await h.call('POST', '/bet/report', { token: 'nope', body: { value: 3 } })).status, 403);
    const saved = await h.call('POST', '/bet/report', { body: { value: '3' } });
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
  // the footer is one link: the working count, or the team when nothing runs
  assert.match(html, /<div class="foot" id="foot"><button type="button" class="quiet" id="working" aria-haspopup="dialog">the team<\/button><\/div>/);
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

test('page: an answer is a conversation that keeps going: the reply holds, then the next card comes on its own', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the tapped answer holds as chosen while it saves, and the next card is asked for during the hold
  assert.match(script, /answer\(b, \{ choice: c\.id \}\);/);
  assert.match(script, /var heldAt = hold\(spot\);\n\s+api\('\/bet\/answer', body\)\.catch\(offline\)\.then\(function \(r\) \{\n\s+if \(r\.ok\) \{ think\(false, heldAt\); return; \}/);
  // if it does not go through, why takes the hint's line under the answers, and nothing moves
  assert.match(script, /if \(hint\) hint\.textContent = r\.message \|\| 'that did not go through';/);
  // a yes or a nice still shows its thanks, and moveOn taps the orb after AFTER_MS
  assert.match(script, /function moveOn\(ack\) \{[\s\S]*?setTimeout\(function \(\) \{ tapOrb\(false\); \}, AFTER_MS\);/);
  assert.match(script, /var AFTER_MS = 1500;/);
  // a question with no fact shows on its own
  assert.match(script, /if \(q\.line\) box\.appendChild\(el\('p', 'why', q\.line\)\);/);
});

test('page: the idle orb answers the pointer like the landing orb, and only the pointer', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // StippleOrb's constants, copied: dots within RADIUS are pushed out by PUSH,
  // then spring home; the ripple runs out from where the pointer came in
  assert.deepEqual(['RADIUS', 'PUSH', 'SPRING', 'DAMP', 'WAVE_SPEED', 'WAVE_WIDTH', 'WAVE_LIFE'].map(num), [90, 14, 0.07, 0.8, 620, 70, 1.6]);
  // the push only in the idle sphere, never under reduced motion
  assert.match(script, /if \(mode === 'idle'\) \{\n\s+var homeX = cx \+ rx \* R, homeY = cy \+ d\.y \* R;/);
  assert.match(script, /if \(pointer\.inside && !reduced\) \{/);
  assert.match(script, /var f = \(1 - dist \/ RADIUS\) \* PUSH;\n\s+d\.vx \+= \(dx \/ dist\) \* f \* 0\.2;/);
  // the light eases toward the pointer anywhere on the page (trackWindow), as on the landing page
  assert.match(script, /light\.x \+= \(light\.tx - light\.x\) \* 0\.06;/);
  assert.match(script, /var reach = Math\.max\(280, window\.innerWidth \* 0\.4\);/);
  assert.match(script, /window\.addEventListener\('pointermove', lightFrom\);/);
  // the ripple starts where the pointer enters the orb
  assert.match(script, /canvas\.addEventListener\('pointerenter', function \(e\) \{/);
  // pointer events go through to the dots on touch too; a tap still thinks
  assert.match(html, /\.stage canvas \{[^}]*touch-action: none;/);
  assert.match(script, /node\.addEventListener\('click', function \(\) \{ tapOrb\(false\); \}\);/);
  // still no loop of its own: no new keyframes, and the tap timings are untouched
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
  assert.deepEqual(['GROW_MS', 'SETTLE_MS', 'LEAVE_MS', 'GLIDE_MS', 'BEAT_MS', 'FAST_GROW_MS', 'FAST_SETTLE_MS', 'FAST'].map(num), [1050, 900, 400, 520, 340, 460, 440, 0.4]);
});

test('page: card to card is one calm turn in place: crossfade, a small drift, the box eases its height, the orb stays still', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // short and soft: one crossfade with a small drift, well under half a second
  assert.equal(num('TURN_IN_MS'), 320);
  assert.equal(num('DRIFT'), 4);
  assert.ok(80 + num('TURN_IN_MS') < 500, 'a turn is well under half a second');
  // a tap with a card up turns in place; the orb melt is only for leaving to the sphere
  assert.match(script, /var onCard = document\.body\.classList\.contains\('has-card'\);/);
  assert.match(script, /if \(onCard && isCard\(s\)\) \{ turn\(s\); return; \}/);
  assert.match(script, /if \(onCard\) \{ dissolve\(function \(\) \{ reveal\(s, true\); \}\); return; \}/);
  // the box holds its height while the old card leaves, then eases to the new one
  assert.match(script, /box\.style\.height = from \+ 'px';/);
  assert.match(script, /box\.style\.height = to \+ 'px';/);
  // picking from a choice holds as chosen, then is a turn too
  assert.match(script, /if \(r\.http === 200 && r\.bet\) \{ afterHold\(heldAt\)\.then\(function \(\) \{ turn\(r\); \}\); return; \}/);
  // the transitions: opacity, a small transform, and height; no new loops.
  // the new card starts 80ms into the old one's fade, and height eases in
  // and out, so no single frame moves far
  assert.match(html, /\.bet\.turning \{ overflow: hidden; transition: opacity 0\.32s ease-out 0\.08s, transform 0\.32s cubic-bezier\(0\.22, 1, 0\.36, 1\) 0\.08s, height 0\.36s cubic-bezier\(0\.4, 0, 0\.2, 1\); \}/);
  assert.match(html, /\.bet\.ghost\.gone \{ opacity: 0; \}/);
  // the still copy sits exactly over the card, measured to the subpixel
  assert.match(script, /ghost\.style\.top = \(r\.top - p\.top\) \+ 'px';/);
  // the reply after a yes or a nice keeps the card's height until the turn eases it
  assert.match(script, /function moveOn\(ack\) \{\n\s+var box = document\.getElementById\('bet'\);\n\s+box\.style\.minHeight = box\.offsetHeight \+ 'px';/);
  assert.match(script, /var from = box\.offsetHeight;\n\s+box\.style\.height = from \+ 'px';\n\s+box\.style\.minHeight = '';/);
  assert.match(html, /\.bet\.turn-in \{ opacity: 0; transform: translateY\(4px\); transition: none; \}/);
  assert.deepEqual([...html.matchAll(/@keyframes ([a-z-]+)/g)].map(m => m[1]), ['sine-x', 'sine-y', 'spin']);
  // reduced motion: the new card simply takes the old one's place
  assert.match(script, /if \(reduced\) \{ box\.style\.minHeight = ''; draw\(\); bet\.busy = false; measured\(\); return; \}/);
  // leaving to the sphere clears the height lock too
  assert.match(script, /var swap = function \(\) \{\n\s+box\.style\.minHeight = '';/);
});

test('page: a tap on a card fades it, glides home to the sphere, and the fast bloom stays contained', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  // the page script parses
  assert.doesNotThrow(() => new Function(script));
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  // the card fades out softly in place, never a cut
  assert.match(html, /\.bet\.leave \{ opacity: 0; transform: none; transition: opacity 0\.4s ease-out; \}/);
  assert.doesNotMatch(script, /reduced \? 200 : 60/);
  assert.equal(num('LEAVE_MS'), 400);
  // the small orb glides to where the sphere will sit, read before anything moves
  assert.match(script, /var to = sphereSpot\(\);/);
  assert.match(script, /orb\.melt\(then, to, swap\)/);
  // the sphere grows back and holds for a beat before the next reveal
  assert.ok(num('BEAT_MS') >= 200);
  // the queued bet's bloom stays under 80% of the smaller window side and never dims the page
  assert.ok(num('BLOOM') < 0.8);
  assert.match(script, /BLOOM \* Math\.min\(window\.innerWidth, window\.innerHeight\) \/ 2/);
  assert.match(script, /dim\.style\.opacity = contained \? '0'/);
  // the bet still being made keeps the full grow toward the farthest corner
  assert.match(script, /var growMs = contained \? FAST_GROW_MS : \(GROW_MS \* pace\);/);
  // tap to card on the fast path: glide, beat, pull, bloom, settle, card fade
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
  const [typed, said, suggestion, idea] = out.stretches;
  const show = s => JSON.stringify(s);
  // one: "something else" turns into the field at the same size and spot, the
  // cursor already in it; the other answers dim and stay put
  assert.deepEqual(typed.field_vs_button_px, { moved: 0, resized: 0 }, show(typed));
  assert.equal(typed.cursor_in_field, true);
  assert.ok(typed.others_dimmed_to < 0.6, show(typed));
  // "or say something" does the same in its own spot, at the same height
  assert.deepEqual(said.field_vs_button_px, { center_moved: 0, height_change: 0 }, show(said));
  assert.equal(said.cursor_in_field, true);
  for (const s of [typed, said, suggestion, idea]) {
    // two and four: the typed words or the tapped answer hold in that spot,
    // styled as chosen, for about 400ms, and nothing else on the card moves
    assert.equal(s.held_as_chosen, true, show(s));
    assert.equal(s.held_moved_px, 0, show(s));
    assert.equal(s.others_moved_px, 0, show(s));
    assert.ok(s.hold_ms >= 380 && s.hold_ms <= 1500, show(s));
    // three: the next card crossfades in with its title where the old title was,
    // under a still copy of the old card fading in the very same spot
    assert.ok(s.ghost_title_px !== null && s.ghost_title_px <= 1, show(s));
    assert.ok(s.title_max_px <= 5, show(s));
    assert.equal(s.title_rest_px, 0, show(s));
    assert.ok(s.largest_frame_step_px <= 5, show(s));
  }
  for (const s of [suggestion, idea]) assert.ok(s.others_dimmed_to < 0.6, show(s));
  // a reply instead of a card: it takes the title's spot, its suggested
  // replies sit where the answers were
  assert.equal(said.next_title, trace.REPLY);
  assert.deepEqual(said.suggestions.slice(0, 2), ['sounds good', 'make it shorter']);
  // the answer to the next card, or the reply, fully in: the hold, then one crossfade
  for (const s of [typed, said, suggestion, idea]) assert.ok(s.reveal_ms >= 400 && s.reveal_ms < 1500, show(s));
});

test('page: an answer holds for HOLD_MS, then one crossfade; tap to card stays about two seconds', () => {
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const num = name => Number(script.match(new RegExp(`\\b${name} = ([0-9.]+)`))[1]);
  assert.equal(num('HOLD_MS'), 400);
  // answer to next card: the hold, then the new card fades in after a short overlap
  const answerToCard = num('HOLD_MS') + num('TURN_IN_MS') + 80;
  assert.ok(answerToCard <= 900, `answer to card ${answerToCard}ms`);
  // the old one waited AFTER_MS on a line of thanks first; that wait is only for yes and nice now
  assert.ok(answerToCard < num('AFTER_MS'));
  // the next card is asked for while the answer holds, never after it
  assert.match(script, /Promise\.all\(\[api\('\/bet\/think', \{ sharper: Boolean\(sharper\) \}\), afterHold\(heldAt\)\]\)/);
  // no second box: the old something-else box and the card say box are gone
  assert.doesNotMatch(script, /function ownAnswer\(|function sayConvo\(/);
  // the field takes the tapped button's own height to the subpixel, so nothing under it moves
  assert.match(script, /field\.style\.height = btn\.getBoundingClientRect\(\)\.height \+ 'px';/);
  // a crossfade, not out then in: the old card is a still copy fading over the new one
  assert.match(html, /\.bet\.ghost \{ position: absolute;/);
  assert.equal(num('DRIFT'), 4);
  assert.match(html, /\.bet\.turn-in \{ opacity: 0; transform: translateY\(4px\); transition: none; \}/);
});
