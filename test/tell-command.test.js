'use strict';

// atris tell: one note to one team member, with a receipt. Every test talks to
// a fake server; nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { tellCommand } = require('../commands/tell');
const { channelCommand } = require('../commands/channel');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tell-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const TOKEN = 'secret-tok-1a2b3c4d5e6f';
const LABS_ID = '5db129d0-aa32-46eb-81ae-29bb86f67b0f';
const BASE = `/swarlo/${LABS_ID}`;
const REGISTRY = { 'atris-labs': { business_id: LABS_ID, name: 'Atris Labs', slug: 'atris-labs' } };

function makeHome(registry) {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  if (registry) fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify(registry));
  return home;
}
const makeFolder = () => fs.mkdtempSync(path.join(scratch, 'cwd-'));

const SENT = {
  saved: true, post_id: '6c0b6823', channel: 'general', to: 'arjun', delivered: true, seq: 39,
  state: 'delivered', wakes: false, wake_reason: 'turned_off', note: 'Arjun reads it on the next run.', next: 'atris tell status 6c0b6823',
};

function fakeServer(overrides = {}) {
  return async (pathname, options = {}) => {
    const method = options.method || 'GET';
    const key = `${method} ${pathname}`;
    if (overrides[key]) return overrides[key](options);
    if (key === `POST ${BASE}/tell`) return { ok: true, status: 201, data: SENT };
    if (key === `GET ${BASE}/channels`) return { ok: true, status: 200, data: { channels: ['general'] } };
    if (key === `POST ${BASE}/channels/general/posts`) return { ok: true, status: 201, data: { post_id: 'n1', ...options.body } };
    const team = pathname.match(/^\/business\/[^/]+\/team\/([^/]+)$/);
    if (method === 'GET' && team) {
      return team[1] === 'walsh'
        ? { ok: true, status: 200, data: { agent_id: 'agent-walsh-id', name: 'walsh' } }
        : { ok: false, status: 404, data: { detail: 'Team member not found' } };
    }
    return { ok: false, status: 404, data: { detail: 'Not Found' } };
  };
}

function harness({ handler = fakeServer(), env = {}, token = TOKEN } = {}) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  return {
    stdout,
    stderr,
    calls,
    all: () => stdout.concat(stderr).join('\n'),
    deps: {
      token,
      ensureCredentials: async () => ({ error: 'none' }),
      env: { ATRIS_BUSINESS: 'atris-labs', ...env },
      cwd: makeFolder(),
      homeDir: makeHome(REGISTRY),
      apiRequestJson: async (pathname, options = {}) => {
        calls.push({ pathname, method: options.method || 'GET', body: options.body, token: options.token });
        return handler(pathname, options);
      },
      log: (l) => stdout.push(String(l)),
      err: (l) => stderr.push(String(l)),
    },
  };
}

// ── send ────────────────────────────────────────────────────

test('send prints saved, delivered, wakes, and the check command', async () => {
  const h = harness();
  const code = await tellCommand(['arjun', 'check the signup page'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(h.stdout, [
    'saved      in #general for arjun',
    "delivered  it is in arjun's inbox",
    "wakes      no. waking on notes is off for arjun, so it waits for arjun's next run",
    'wake       atris tell wake arjun on --business atris-labs',
    'check      atris tell status 6c0b6823 --business atris-labs',
  ]);
  const sent = h.calls.find((c) => c.method === 'POST');
  assert.equal(sent.pathname, `${BASE}/tell`);
  const { idempotency_key: key, ...rest } = sent.body;
  assert.deepEqual(rest, { member: 'arjun', text: 'check the signup page', task_key: null, channel: null });
  assert.match(key, /^[0-9a-f-]{36}$/);
  assert.equal(sent.token, TOKEN);
});

test('each send carries its own retry key, so a retried request never sends twice', async () => {
  const keys = [];
  for (let i = 0; i < 2; i += 1) {
    const h = harness();
    assert.equal(await tellCommand(['arjun', 'hello'], h.deps), 0, h.all());
    keys.push(h.calls.find((c) => c.method === 'POST').body.idempotency_key);
  }
  assert.ok(keys[0] && keys[1] && keys[0] !== keys[1]);
});

test('saved but not confirmed says so, never claims delivery, and exits zero', async () => {
  const note = 'Saved. Could not confirm it reached the inbox yet; check with channel_receipt before sending again.';
  const h = harness({ handler: fakeServer({ [`POST ${BASE}/tell`]: () => ({ ok: true, status: 201, data: { ...SENT, delivered: null, seq: null, state: 'saved', wakes: false, wake_reason: 'unknown', note } }) }) });
  const code = await tellCommand(['arjun', 'hello'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(h.stdout, [
    'saved      in #general for arjun',
    'delivered  saved, not confirmed yet. check status before sending again',
    'check      atris tell status 6c0b6823 --business atris-labs',
  ]);
  assert.ok(!/it is in arjun's inbox|not delivered/.test(h.all()));
});

test('--task, --channel and --as go to the server; a leading @ is dropped', async () => {
  const h = harness();
  const code = await tellCommand(['@arjun', 'ship it', '--task', 'signup-1', '--channel', '#ops', '--as', 'walsh'], h.deps);
  assert.equal(code, 0, h.all());
  const sent = h.calls.find((c) => c.method === 'POST');
  const { idempotency_key: key, ...rest } = sent.body;
  assert.deepEqual(rest, { member: 'arjun', text: 'ship it', task_key: 'signup-1', channel: 'ops', agent_id: 'agent-walsh-id' });
  assert.ok(key);
});

test('--json passes the server reply through untouched', async () => {
  const h = harness();
  const code = await tellCommand(['arjun', 'hello', '--json'], h.deps);
  assert.equal(code, 0);
  assert.equal(h.stdout.length, 1);
  assert.deepEqual(JSON.parse(h.stdout[0]), SENT);
});

test('not delivered is said first and exits non-zero', async () => {
  const h = harness({ handler: fakeServer({ [`POST ${BASE}/tell`]: () => ({ ok: true, status: 201, data: { ...SENT, delivered: false, note: 'arjun has no inbox yet' } }) }) });
  const code = await tellCommand(['arjun', 'hello'], h.deps);
  assert.equal(code, 1);
  assert.match(h.stdout[0], /^not delivered {2}arjun has no inbox yet\.$/);
  assert.ok(!h.all().includes("it is in arjun's inbox"));
});

test('a reply with no delivered field never claims delivery', async () => {
  const h = harness({ handler: fakeServer({ [`POST ${BASE}/tell`]: () => ({ ok: true, status: 201, data: { saved: true } }) }) });
  const code = await tellCommand(['arjun', 'hello'], h.deps);
  assert.equal(code, 0, h.all());
  assert.match(h.all(), /delivered {2}unknown, the server did not say/);
  assert.ok(!/inbox/.test(h.all()));
});

test('an unknown member shows the server message with the team names and exits non-zero', async () => {
  const h = harness({ handler: fakeServer({ [`POST ${BASE}/tell`]: () => ({ ok: false, status: 404, data: { detail: 'No member called arjn. Members: arjun, walsh, amara' } }) }) });
  const code = await tellCommand(['arjn', 'hello'], h.deps);
  assert.equal(code, 1);
  assert.match(h.stderr.join('\n'), /nothing was sent to arjn: No member called arjn\. Members: arjun, walsh, amara/);
  assert.equal(h.stdout.length, 0);
});

test('an unknown member as an object reply still lists the names', async () => {
  const h = harness({ handler: fakeServer({ [`POST ${BASE}/tell`]: () => ({ ok: false, status: 404, data: { detail: { message: 'No member called arjn', members: ['arjun', 'walsh'] } } }) }) });
  const code = await tellCommand(['arjn', 'hello'], h.deps);
  assert.equal(code, 1);
  assert.match(h.stderr.join('\n'), /No member called arjn\. members: arjun, walsh/);
  assert.ok(!h.all().includes('{'));
});

test('an old server without the tell route gives the channel fallback line', async () => {
  const h = harness({ handler: fakeServer({ [`POST ${BASE}/tell`]: () => ({ ok: false, status: 404, data: { detail: 'Not Found' } }) }) });
  const code = await tellCommand(['arjun', 'hello'], h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.stderr, ['This Atris server does not have tell yet. Use: atris channel general "@arjun ..."']);
});

test('no sign-in gives the same message as atris channel', async () => {
  const h = harness({ token: '' });
  const code = await tellCommand(['arjun', 'hello'], h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.stderr, ['not logged in. run: atris login']);
  assert.equal(h.calls.length, 0);
});

test('no arguments prints short usage with one example; a missing message is refused', async () => {
  const h = harness();
  assert.equal(await tellCommand([], h.deps), 0);
  assert.match(h.stdout.join('\n'), /usage: atris tell <member> "message"/);
  assert.match(h.stdout.join('\n'), /example: atris tell arjun /);
  const h2 = harness();
  assert.equal(await tellCommand(['arjun'], h2.deps), 1);
  assert.match(h2.stderr[0], /say what to tell arjun/);
  assert.equal(h2.calls.length, 0);
});

// ── status ──────────────────────────────────────────────────

test('status prints one plain line per person for each state, with the server note', async () => {
  const receipt = {
    post_id: '6c0b6823', channel: 'general', task_key: null,
    recipients: [
      { to: 'arjun', seq: 39, state: 'seen' },
      { to: 'walsh', state: 'accepted' },
      { to: 'amara', state: 'completed', note: 'Shipped the fix' },
      { to: 'muse', state: 'delivered' },
      { to: 'grok', state: 'failed' },
      { to: 'kai', state: 'blocked', note: 'needs a login.' },
    ],
  };
  const h = harness({ handler: fakeServer({ [`GET ${BASE}/posts/6c0b6823/receipt`]: () => ({ ok: true, status: 200, data: receipt }) }) });
  const code = await tellCommand(['status', '6c0b6823'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(h.stdout, [
    'arjun  seen, not picked up yet',
    'walsh  picked up, working on it',
    'amara  finished. Shipped the fix.',
    'muse   in the inbox, not seen yet',
    'grok   tried it and failed',
    'kai    blocked, needs help. needs a login.',
  ]);
});

test('status --json passes the receipt through; an old server says so', async () => {
  const receipt = { post_id: 'p1', recipients: [{ to: 'arjun', state: 'seen' }] };
  const h = harness({ handler: fakeServer({ [`GET ${BASE}/posts/p1/receipt`]: () => ({ ok: true, status: 200, data: receipt }) }) });
  assert.equal(await tellCommand(['status', 'p1', '--json'], h.deps), 0);
  assert.deepEqual(JSON.parse(h.stdout[0]), receipt);
  const old = harness();
  assert.equal(await tellCommand(['status', 'p1'], old.deps), 1);
  assert.match(old.stderr[0], /does not have tell receipts yet/);
});

test('status prints plain durations from the receipt times and never crashes on missing ones', async () => {
  const receipt = {
    post_id: 'p2', sent_at: '2026-11-17T10:00:00Z',
    recipients: [
      { to: 'arjun', state: 'seen', seconds_to_first_reply: 48 },
      { to: 'walsh', state: 'completed', first_reply_at: '2026-11-17T10:00:05Z', completed_at: '2026-11-17T10:03:00Z' },
      { to: 'amara', state: 'accepted', first_reply_at: 'not a time', completed_at: null },
      { state: 'delivered' },
      null,
    ],
  };
  const h = harness({ handler: fakeServer({ [`GET ${BASE}/posts/p2/receipt`]: () => ({ ok: true, status: 200, data: receipt }) }) });
  assert.equal(await tellCommand(['status', 'p2'], h.deps), 0, h.all());
  assert.deepEqual(h.stdout, [
    'arjun    seen, not picked up yet, answered in 48 seconds',
    'walsh    finished in 3 minutes, answered in 5 seconds',
    'amara    picked up, working on it',
    'someone  in the inbox, not seen yet',
  ]);
});

// ── wake on notes ───────────────────────────────────────────

const TEAM_PATCH = `PATCH /business/${LABS_ID}/team/arjun`;

test('wake on switches wake_on_mention and says what it costs', async () => {
  const h = harness({ handler: fakeServer({ [TEAM_PATCH]: (o) => ({ ok: true, status: 200, data: { agent_id: 'a1', slug: 'arjun', updated: { wake_on_mention: o.body.wake_on_mention } } }) }) });
  assert.equal(await tellCommand(['wake', 'arjun', 'on'], h.deps), 0, h.all());
  assert.deepEqual(h.calls.at(-1).body, { wake_on_mention: true });
  assert.deepEqual(h.stdout, ["arjun now wakes when sent a note. Each wake runs arjun's computer on the business's credits, up to the daily limit."]);
  const off = harness({ handler: fakeServer({ [TEAM_PATCH]: () => ({ ok: true, status: 200, data: { updated: { wake_on_mention: { enabled: false } } } }) }) });
  assert.equal(await tellCommand(['wake', 'arjun', 'off'], off.deps), 0, off.all());
  assert.deepEqual(off.stdout, ['arjun no longer wakes for notes.']);
});

test('wake on an old server that ignores the field says so and exits non-zero', async () => {
  const h = harness({ handler: fakeServer({ [TEAM_PATCH]: () => ({ ok: true, status: 200, data: { agent_id: 'a1', slug: 'arjun', updated: {} } }) }) });
  assert.equal(await tellCommand(['wake', 'arjun', 'on'], h.deps), 1);
  assert.match(h.stderr[0], /does not have waking on notes yet, so nothing changed for arjun/);
  assert.equal(h.stdout.length, 0);
});

test('wake refuses a bad switch and names an unknown member plainly', async () => {
  const bad = harness();
  assert.equal(await tellCommand(['wake', 'arjun', 'maybe'], bad.deps), 1);
  assert.match(bad.stderr[0], /like: atris tell wake arjun on/);
  assert.equal(bad.calls.length, 0);
  const h = harness({ handler: fakeServer({ [`PATCH /business/${LABS_ID}/team/arjn`]: () => ({ ok: false, status: 404, data: { detail: 'Agent not found: arjn' } }) }) });
  assert.equal(await tellCommand(['wake', 'arjn', 'on'], h.deps), 1);
  assert.deepEqual(h.stderr, ['no member called "arjn" in atris-labs, so nothing changed']);
});

// ── --wait: the stopwatch ───────────────────────────────────

// A fake clock: sleeping moves time forward, and each receipt read returns
// the next step of a script (the last step repeats).
function stopwatch(steps) {
  let clock = Date.parse('2026-11-17T10:00:00Z');
  let reads = 0;
  const handler = fakeServer({
    [`GET ${BASE}/posts/6c0b6823/receipt`]: () => {
      const step = steps[Math.min(reads, steps.length - 1)];
      reads += 1;
      return typeof step === 'function' ? step() : { ok: true, status: 200, data: step };
    },
  });
  const h = harness({ handler });
  h.deps.now = () => clock;
  h.deps.sleep = async (ms) => { clock += ms; };
  return h;
}
const person = (fields) => ({ post_id: '6c0b6823', recipients: [{ to: 'arjun', ...fields }] });

test('--wait prints one line per change and stops when the member answers', async () => {
  const h = stopwatch([person({ state: 'delivered' }), person({ state: 'delivered' }), person({ state: 'seen' }), person({ state: 'accepted', seconds_to_first_reply: 15 })]);
  const code = await tellCommand(['arjun', 'ping', '--wait', '60'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(h.stdout.slice(5), [
    'waiting up to 60 seconds for arjun',
    '   5s  arjun in the inbox, not seen yet',
    '  15s  arjun seen, not picked up yet',
    '  20s  arjun picked up, working on it, answered in 15 seconds',
    'answered in 20 seconds',
  ]);
});

test('--wait --json returns the final receipt plus waited_seconds', async () => {
  const h = stopwatch([person({ state: 'seen' }), person({ state: 'completed' })]);
  const code = await tellCommand(['arjun', 'ping', '--wait', '--json'], h.deps);
  assert.equal(code, 0, h.all());
  assert.equal(h.stdout.length, 1);
  assert.deepEqual(JSON.parse(h.stdout[0]), { ...person({ state: 'completed' }), waited_seconds: 10 });
});

test('--wait runs out of time, survives missing fields, and exits non-zero', async () => {
  const h = stopwatch([() => ({ ok: false, status: 500, data: null }), () => ({ ok: true, status: 200, data: {} }), person({})]);
  const code = await tellCommand(['arjun', 'ping', '--wait', '12'], h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.stdout.slice(-2), ['  12s  arjun no word on it yet', 'no answer from arjun after 12 seconds']);
});

// The server's receipt rows carry name and member_id, not to.
const MEMBERS = (rows) => ({ post_id: '6c0b6823', recipients: rows });

test('--wait watches the member the note went to by id, not the first row', async () => {
  const sent = { ...SENT, to: 'Arjun', member_id: 'agent-arjun' };
  const h = stopwatch([MEMBERS([
    { name: 'Walsh', member_id: 'agent-walsh', state: 'completed' },
    { name: 'Arjun', member_id: 'agent-arjun', state: 'seen' },
  ]), MEMBERS([
    { name: 'Walsh', member_id: 'agent-walsh', state: 'completed' },
    { name: 'Arjun', member_id: 'agent-arjun', state: 'completed' },
  ])]);
  h.deps.apiRequestJson = ((inner) => async (p, o = {}) => (o.method === 'POST' && p === `${BASE}/tell`
    ? { ok: true, status: 201, data: sent } : inner(p, o)))(h.deps.apiRequestJson);
  const code = await tellCommand(['arjun', 'ping', '--wait', '60'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(h.stdout.slice(-3), ['   5s  Arjun seen, not picked up yet', '  10s  Arjun finished', 'finished in 10 seconds']);
});

test('--wait matches a name in any case when the row has no id', async () => {
  const h = stopwatch([MEMBERS([{ name: 'Walsh', state: 'delivered' }, { name: 'ARJUN', state: 'completed' }])]);
  assert.equal(await tellCommand(['arjun', 'ping', '--wait', '20'], h.deps), 0, h.all());
  assert.equal(h.stdout.at(-1), 'finished in 5 seconds');
});

test('--wait stops plainly when the receipt does not list the member', async () => {
  const sent = { ...SENT, member_id: 'agent-arjun' };
  const h = stopwatch([MEMBERS([{ name: 'arjun', member_id: 'agent-other-arjun', state: 'completed' }, { name: 'Walsh', member_id: 'agent-walsh', state: 'completed' }])]);
  h.deps.apiRequestJson = ((inner) => async (p, o = {}) => (o.method === 'POST' && p === `${BASE}/tell`
    ? { ok: true, status: 201, data: sent } : inner(p, o)))(h.deps.apiRequestJson);
  const code = await tellCommand(['arjun', 'ping', '--wait', '20'], h.deps);
  assert.equal(code, 1);
  assert.deepEqual(h.stderr, ['the receipt does not list arjun, so --wait stopped here. check: atris tell status 6c0b6823 --business atris-labs']);
  assert.ok(!/finished/.test(h.stdout.join('\n')));
});

test('status names each person from the server rows', async () => {
  const receipt = MEMBERS([{ name: 'Nova', member_id: 'agent-nova', state: 'seen' }]);
  const h = harness({ handler: fakeServer({ [`GET ${BASE}/posts/6c0b6823/receipt`]: () => ({ ok: true, status: 200, data: receipt }) }) });
  assert.equal(await tellCommand(['status', '6c0b6823'], h.deps), 0, h.all());
  assert.deepEqual(h.stdout, ['Nova  seen, not picked up yet']);
});

test('--wait on an old server without receipts says so', async () => {
  const h = stopwatch([() => ({ ok: false, status: 404, data: { detail: 'Not Found' } })]);
  assert.equal(await tellCommand(['arjun', 'ping', '--wait'], h.deps), 1);
  assert.match(h.stderr[0], /does not have tell receipts yet/);
});

// ── --wait on a server that waits for the answer itself ─────

// Each send returns the next step of a script and moves the fake clock by the
// wait it asked for, as a server holding the call open would.
function answerServer(steps, receiptStep = null) {
  let clock = Date.parse('2026-11-18T10:00:00Z');
  let sends = 0;
  const handler = fakeServer({
    [`POST ${BASE}/tell`]: (options) => {
      const step = steps[Math.min(sends, steps.length - 1)];
      sends += 1;
      clock += (options.body.wait_seconds || 0) * 1000 * (step.answered ? 0.4 : 1);
      return { ok: true, status: 201, data: { ...SENT, wakes: true, wake_reason: 'queued', ...step } };
    },
    [`GET ${BASE}/posts/6c0b6823/receipt`]: () => (receiptStep
      ? { ok: true, status: 200, data: receiptStep }
      : { ok: true, status: 200, data: person({ state: 'seen' }) }),
  });
  const h = harness({ handler });
  h.deps.now = () => clock;
  h.deps.sleep = async (ms) => { clock += ms; };
  h.deps.newKey = () => 'key-1';
  return h;
}
const sends = (h) => h.calls.filter((c) => c.method === 'POST' && c.pathname === `${BASE}/tell`);

test('--wait prints the answer that comes back with the send', async () => {
  const h = answerServer([{ answered: true, accepted: false, answer: 'Yes, since this morning.', seconds: 10 }]);
  const code = await tellCommand(['arjun', 'is the fix live?', '--wait'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(sends(h).map((c) => c.body.wait_seconds), [25]);
  assert.deepEqual(h.stdout.slice(-2), ['arjun: Yes, since this morning.', 'answered in 10 seconds']);
});

test('--wait asks again with the same key, says when the member is on it, then prints the answer', async () => {
  const h = answerServer([
    { answered: false, accepted: true, on_it: 'On it: checking the deploy log.', answer: null },
    { answered: true, accepted: true, on_it: 'On it: checking the deploy log.', answer: 'Deploy is healthy.\nNo errors since 9.' },
  ]);
  const code = await tellCommand(['arjun', 'check the deploy', '--wait', '60'], h.deps);
  assert.equal(code, 0, h.all());
  const posts = sends(h);
  assert.deepEqual(posts.map((c) => [c.body.idempotency_key, c.body.wait_seconds]), [['key-1', 25], ['key-1', 25]]);
  assert.deepEqual(h.stdout.slice(-3), [
    '  25s  arjun is on it: On it: checking the deploy log.',
    'arjun: Deploy is healthy.\nNo errors since 9.',
    'answered in 35 seconds',
  ]);
});

test('--wait with no answer stops at the time limit, sends once per ask, and exits non-zero', async () => {
  const h = answerServer([{ answered: false, accepted: false, answer: null }]);
  const code = await tellCommand(['arjun', 'ping', '--wait', '30'], h.deps);
  assert.equal(code, 1);
  assert.deepEqual(sends(h).map((c) => [c.body.idempotency_key, c.body.wait_seconds]), [['key-1', 25], ['key-1', 5]]);
  assert.equal(h.stdout.at(-1), 'no answer from arjun after 30 seconds. check: atris tell status 6c0b6823 --business atris-labs');
});

test('--wait --json returns the receipt with the answer', async () => {
  const h = answerServer([{ answered: true, accepted: false, answer: 'Yes.' }]);
  assert.equal(await tellCommand(['arjun', 'ping', '--wait', '--json'], h.deps), 0, h.all());
  assert.equal(h.stdout.length, 1);
  const out = JSON.parse(h.stdout[0]);
  assert.equal(out.answer, 'Yes.');
  assert.equal(out.answered, true);
  assert.equal(out.waited_seconds, 10);
});

test('--wait strips terminal control characters from the answer', async () => {
  const h = answerServer([{ answered: true, answer: 'ok\u001b[2J done\u0007' }]);
  assert.equal(await tellCommand(['arjun', 'ping', '--wait'], h.deps), 0, h.all());
  assert.equal(h.stdout.at(-2), 'arjun: ok[2J done');
});

test('--wait stops when a task report finishes it without a reply', async () => {
  const h = answerServer([{ answered: false, accepted: false, answer: null }], person({ state: 'completed' }));
  assert.equal(await tellCommand(['arjun', 'ship it', '--task', 't1', '--wait', '60'], h.deps), 0, h.all());
  assert.equal(sends(h).length, 1);
  assert.equal(h.stdout.at(-1), 'finished in 25 seconds');
});

test('a send without --wait asks the server for no wait', async () => {
  const h = answerServer([{}]);
  assert.equal(await tellCommand(['arjun', 'hello'], h.deps), 0, h.all());
  assert.equal('wait_seconds' in sends(h)[0].body, false);
});

// ── channel posts ───────────────────────────────────────────

test('a channel post prints who it reached only when the server says', async () => {
  const reached = harness({ handler: fakeServer({ [`POST ${BASE}/channels/general/posts`]: () => ({ ok: true, status: 201, data: { post_id: 'n1', delivered_to: [{ to: 'arjun', seq: 4, wakes: false, wake_reason: 'turned_off' }, { to: 'walsh', wakes: true }] } }) }) });
  assert.equal(await channelCommand(['general', '@arjun @walsh hi'], reached.deps), 0, reached.all());
  assert.deepEqual(reached.stdout, ['posted to #general', "reached arjun's inbox, will not wake", "reached walsh's inbox, will wake"]);

  const plain = harness();
  assert.equal(await channelCommand(['general', 'hi'], plain.deps), 0, plain.all());
  assert.deepEqual(plain.stdout, ['posted to #general']);
});

test('channel usage points at atris tell', async () => {
  const h = harness();
  await channelCommand(['--help'], h.deps);
  assert.match(h.stdout.join('\n'), /to reach one member: atris tell <member> "\.\.\."/);
});

// ── the real CLI ────────────────────────────────────────────

function runCli(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TOKEN: '', ATRIS_AGENT: '', ATRIS_BUSINESS: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('tell is a known command and shows in help --all and help --json', async () => {
  assert.ok(knownCommands.includes('tell'));
  const all = await runCli(['help', '--all'], { cwd: makeFolder(), env: { HOME: makeHome() } });
  assert.match(all.stdout, /\n\s+tell\s+-/);
  const json = await runCli(['help', '--json'], { cwd: makeFolder(), env: { HOME: makeHome() } });
  assert.ok(JSON.parse(json.stdout).commands.some((row) => row.name === 'tell'));
});

test('the installed command sends through a real HTTP server with the stored sign-in', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/auth/validate') return send(200, { valid: true, user: { id: 'u1' } });
      if (req.method === 'POST' && req.url === '/api/swarlo/atris-labs/tell') return send(201, SENT);
      return send(404, { detail: 'Not Found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const env = { HOME: makeHome(), ATRIS_API_URL: `http://127.0.0.1:${port}/api`, ATRIS_TOKEN: TOKEN };
    const run = await runCli(['tell', 'arjun', 'check the signup page', '--business', 'atris-labs'], { cwd: makeFolder(), env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /saved {6}in #general for arjun\ndelivered {2}it is in arjun's inbox\n/);
    const sent = seen.find((s) => s.method === 'POST' && s.url.endsWith('/tell'));
    const { idempotency_key: key, ...rest } = JSON.parse(sent.body);
    assert.deepEqual(rest, { member: 'arjun', text: 'check the signup page', task_key: null, channel: null });
    assert.match(key, /^[0-9a-f-]{36}$/);
    assert.equal(sent.auth, `Bearer ${TOKEN}`);
    assert.ok(!(run.stdout + run.stderr).includes(TOKEN));
  } finally {
    server.close();
  }
});
