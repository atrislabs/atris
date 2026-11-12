const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { nightCommand } = require('../commands/night');
const { morningCommand, NO_SHIFT } = require('../commands/morning');
const { joinAgentCommand, isAgentJoin } = require('../commands/join');

const ENV_KEYS = ['HOME', 'ATRIS_TOKEN', 'ATRIS_PROFILE', 'ATRIS_AGENT_TOKEN_FILE', 'ATRIS_CLIENT_ID', 'ATRIS_CLIENT_SECRET'];
const savedEnv = {};
let tmpHome;

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-night-test-'));
  process.env.HOME = tmpHome;
  for (const key of ENV_KEYS.slice(1)) delete process.env[key];
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// A fake backend: records calls and answers from a table keyed by "METHOD path".
function fakeApi(routes) {
  const calls = [];
  const request = async (pathname, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ pathname, method, body: options.body, token: options.token });
    const key = `${method} ${pathname.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected API call: ${key}`);
    return typeof handler === 'function' ? handler(pathname, options, calls) : handler;
  };
  return { request, calls };
}

function io() {
  const out = [];
  const err = [];
  return { out, err, log: (...p) => out.push(p.join(' ')), err_: (...p) => err.push(p.join(' ')) };
}

function deps(api, extra = {}) {
  const sink = io();
  return {
    sink,
    deps: {
      apiRequestJson: api.request,
      loadCredentials: () => ({ token: 'human-token' }),
      loadBusinesses: () => ({}),
      log: sink.log,
      err: sink.err_,
      ...extra,
    },
  };
}

test('night refuses a cap of 0 before calling the backend', async () => {
  const api = fakeApi({});
  for (const cap of ['0', '-1', 'abc', '']) {
    const { sink, deps: d } = deps(api);
    const code = await nightCommand(['learn refunds', '--cap', cap], d);
    assert.equal(code, 1, `cap ${cap}`);
    assert.match(sink.err.join('\n'), /cap must be more than \$0/);
  }
  assert.equal(api.calls.length, 0);
});

test('night starts a shift and prints one plain line', async () => {
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const api = fakeApi({
    'POST /night-shift': { ok: true, status: 200, data: { shift_id: 'sh_123', schedule_id: 'sc_9', starts_at: startsAt } },
  });
  const { sink, deps: d } = deps(api);
  const code = await nightCommand(['learn', 'how refunds work', '--business', 'biz_1'], d);
  assert.equal(code, 0);
  assert.equal(sink.out.length, 1);
  assert.match(sink.out[0], /^Night shift starts at .+ with a \$1 cap\. Shift sh_123\.$/);
  assert.deepEqual(api.calls[0].body, { goal: 'learn how refunds work', cap_usd: 1, business_id: 'biz_1' });
  assert.equal(api.calls[0].token, 'human-token');
});

test('night --watch prints each new event once and stops when capped', async () => {
  let polls = 0;
  const api = fakeApi({
    'POST /night-shift': { ok: true, status: 200, data: { shift_id: 'sh_w', starts_at: new Date().toISOString() } },
    'GET /night-shift/sh_w': () => {
      polls += 1;
      const events = [{ id: 'e1', message: 'Read the refund policy' }];
      if (polls >= 2) events.push({ id: 'e2', message: 'Wrote refunds.md', spent_usd: 0.4 });
      return {
        ok: true,
        status: 200,
        data: { status: polls >= 2 ? 'capped' : 'running', cap_usd: 0.5, spent_usd: 0.5, events },
      };
    },
  });
  const { sink, deps: d } = deps(api, { sleep: async () => {}, pollMs: 0 });
  const code = await nightCommand(['learn refunds', '--cap', '0.5', '--watch'], d);
  assert.equal(code, 0);
  assert.match(sink.out[0], /with a \$0\.50 cap\. Shift sh_w\.$/);
  assert.deepEqual(sink.out.slice(1), [
    'Read the refund policy',
    'Wrote refunds.md ($0.40 so far)',
    'The shift stopped at its cap. Spent $0.50 of $0.50. Read it with: atris morning',
  ]);
});

test('morning prints the receipt text exactly', async () => {
  const text = 'Last night your agent read 4 files.\nIt made refunds.md.\nIt spent $0.62.';
  const api = fakeApi({
    'GET /morning': { ok: true, status: 200, data: { text, receipt: { spent_usd: 0.62 } } },
  });
  const { sink, deps: d } = deps(api);
  const code = await morningCommand(['--business', 'biz_1', '--agent', 'ag_7'], d);
  assert.equal(code, 0);
  assert.deepEqual(sink.out, [text]);
  assert.equal(api.calls[0].pathname, '/morning?business_id=biz_1&agent_id=ag_7');
});

test('morning says so when no night shift has finished', async () => {
  for (const answer of [
    { ok: true, status: 200, data: { text: null, receipt: null } },
    { ok: false, status: 404, data: { detail: 'no shift' }, error: 'no shift' },
  ]) {
    const api = fakeApi({ 'GET /morning': answer });
    const { sink, deps: d } = deps(api);
    const code = await morningCommand([], d);
    assert.equal(code, 0);
    assert.deepEqual(sink.out, [NO_SHIFT]);
    assert.equal(NO_SHIFT, 'No night shift finished yet.');
  }
});

test('morning --json prints the receipt as JSON', async () => {
  const data = { text: 'hi', receipt: { spent_usd: 1 } };
  const api = fakeApi({ 'GET /morning': { ok: true, status: 200, data } });
  const { sink, deps: d } = deps(api);
  assert.equal(await morningCommand(['--json'], d), 0);
  assert.deepEqual(JSON.parse(sink.out.join('\n')), data);
});

test('join stores the agent key and is the same agent on a second run', async () => {
  const { saveCredentials, loadCredentials } = require('../utils/auth');
  saveCredentials('human-token', 'refresh-1', 'owner@example.com', 'user-1', 'test');

  const api = fakeApi({
    'POST /join-as-agent': { ok: true, status: 200, data: { agent_id: 'ag_42', token: 'agent-key-abc', home: { business_name: 'Acme' } } },
  });
  const outputs = [];
  for (let i = 0; i < 2; i++) {
    const sink = io();
    const code = await joinAgentCommand(['--name', 'scout', '--business', 'biz_1', '--mission', 'find buyers'], {
      apiRequestJson: api.request,
      loadBusinesses: () => ({}),
      log: sink.log,
      err: sink.err_,
    });
    assert.equal(code, 0);
    assert.deepEqual(sink.err, []);
    outputs.push(sink.out);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(outputs[0][0], 'Joined Acme as scout. This session now acts as that agent.');
  assert.equal(outputs[0][1], 'Agent ag_42.');
  assert.deepEqual(api.calls[0].body, { business_id: 'biz_1', name: 'scout', mission: 'find buyers' });
  assert.equal(api.calls[0].token, 'human-token');

  const stored = loadCredentials();
  assert.equal(stored.token, 'human-token', 'the login stays the login');
  assert.equal(stored.agent_token, 'agent-key-abc');
  assert.equal(stored.joined_agent.agent_id, 'ag_42');
  assert.equal(stored.joined_agent.business_id, 'biz_1');

  // night then acts for the joined agent by default.
  const nightApi = fakeApi({
    'POST /night-shift': { ok: true, status: 200, data: { shift_id: 'sh_j', starts_at: new Date().toISOString() } },
  });
  const sink = io();
  assert.equal(await nightCommand(['learn'], { apiRequestJson: nightApi.request, log: sink.log, err: sink.err_ }), 0);
  assert.deepEqual(nightApi.calls[0].body, { goal: 'learn', cap_usd: 1, agent_id: 'ag_42', business_id: 'biz_1' });
});

test('join without a business names the personal computer, and routing needs --name', async () => {
  const api = fakeApi({
    'POST /join-as-agent': { ok: true, status: 200, data: { agent_id: 'ag_self', token: 'k', home: 'self' } },
  });
  const { sink, deps: d } = deps(api, { persistMintedAgentToken: () => {} });
  assert.equal(await joinAgentCommand(['--name', 'me'], d), 0);
  assert.equal(sink.out[0], 'Joined your personal computer as me. This session now acts as that agent.');
  assert.deepEqual(api.calls[0].body, { business_id: null, name: 'me' });

  assert.equal(isAgentJoin(['--name', 'x']), true);
  assert.equal(isAgentJoin(['--name=x']), true);
  assert.equal(isAgentJoin(['ABC123']), false);
  assert.equal(isAgentJoin([]), false);
});
