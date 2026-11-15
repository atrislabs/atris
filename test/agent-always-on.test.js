'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentAlwaysOnCommand, parseEvery } = require('../commands/agent-always-on');
const home = require('../lib/agent-home');
const yesLock = require('../lib/yes-lock');

// Local times are read in one fixed zone so "today" holds on any machine.
process.env.TZ = 'America/Los_Angeles';
const NOW = '2026-11-14T15:00:00Z';
const onAnswer = {
  agent_id: 'agent-1', name: 'Scout', on: true, every_minutes: 30, watch: 'new leads in the inbox',
  daily_cap_credits: 40, followups: true, next_check_in: '2026-11-14T15:30:00Z',
};

async function run(args, options = {}) {
  const calls = [];
  const output = [];
  const errors = [];
  const code = await agentAlwaysOnCommand(args, {
    token: options.token === undefined ? 'test-secret' : options.token,
    ensureCredentials: async () => null,
    cwd: options.cwd || os.tmpdir(), env: options.env || {}, now: NOW,
    log: (line) => output.push(line), err: (line) => errors.push(line),
    apiRequestJson: async (route, request) => {
      calls.push({ route, ...request });
      return options.answer ? options.answer(route, request) : { ok: true, status: 200, data: onAnswer };
    },
  });
  return { code, calls, output, errors };
}

test('turn on posts the settings to the agent and explains the price in plain words', async () => {
  const result = await run(['agent-1', '--every', '1h', '--watch', 'new leads in the inbox', '--cap', '100', '--no-followups']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [{
    route: '/agent/agent-1/always-on', method: 'POST', token: 'test-secret',
    body: { every_minutes: 60, watch: 'new leads in the inbox', daily_cap_credits: 100, followups: false },
  }]);
  assert.equal(result.output[0], 'Scout is on. It checks in every 30 minutes.');
  assert.ok(result.output.includes('A quiet check-in is free. A check-in where it does work costs 4 credits (4 cents).'));
  assert.ok(result.output.includes('Daily limit: 40 credits. It stops for the day when it gets there.'));
  assert.ok(result.output.includes('It looks out for: new leads in the inbox'));
  assert.ok(result.output.some((line) => /^Next check-in: today \d/.test(line)));
  assert.equal(result.output.at(-1), 'See the bill: atris agent always-on status agent-1');
  for (const line of result.output) assert.doesNotMatch(line, /\u2014/);
});

test('turn on with no flags sends an empty body, and a price from the server replaces the default', async () => {
  const result = await run(['agent-1'], { answer: () => ({ ok: true, status: 200, data: { ...onAnswer, acted_credits: 6, followups: false } }) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls[0].body, {});
  assert.ok(result.output.includes('A quiet check-in is free. A check-in where it does work costs 6 credits (6 cents).'));
  assert.ok(result.output.includes('Follow-ups are off. It only checks in on the timer.'));
});

test('--every reads minutes and hours, and refuses under 15 minutes or over a day before any request', async () => {
  assert.equal(parseEvery('30m'), 30);
  assert.equal(parseEvery('1h'), 60);
  assert.equal(parseEvery('4h'), 240);
  assert.equal(parseEvery('90'), 90);
  assert.equal(parseEvery('soon'), null);
  for (const [every, minutes] of [['15m', 15], ['24h', 1440], ['90', 90]]) {
    const ok = await run(['agent-1', '--every', every]);
    assert.equal(ok.code, 0, every);
    assert.equal(ok.calls[0].body.every_minutes, minutes);
  }
  for (const [every, pattern] of [['10m', /at most every 15 minutes/], ['14', /at most every 15 minutes/], ['25h', /at least once a day/], ['1441', /at least once a day/], ['soon', /like 30m, 1h, 4h/]]) {
    const bad = await run(['agent-1', '--every', every]);
    assert.equal(bad.code, 1, every);
    assert.equal(bad.calls.length, 0, every);
    assert.match(bad.errors[0], pattern);
  }
});

test('--cap must be a whole number from 4 to 2000', async () => {
  for (const cap of ['4', '2000']) {
    const ok = await run(['agent-1', '--cap', cap]);
    assert.equal(ok.code, 0);
    assert.equal(ok.calls[0].body.daily_cap_credits, Number(cap));
  }
  for (const cap of ['3', '2001', '4.5', '-5', 'lots']) {
    const bad = await run(['agent-1', '--cap', cap]);
    assert.equal(bad.code, 1, cap);
    assert.equal(bad.calls.length, 0, cap);
    assert.match(bad.errors[0], /4 to 2000/);
  }
});

const statusAnswer = {
  agent_id: 'agent-1', name: 'Scout', on: true, every_minutes: 30, watch: null, daily_cap_credits: 40, followups: true,
  next_check_in: '2026-11-14T15:30:00Z', last_check_in: '2026-11-14T15:00:00Z',
  today: { credits: 12, cap_credits: 40, remaining_credits: 28, paused_by_cap: false },
  bill: {
    days: 1, check_ins: 14, quiet: 10, acted: 3, failed: 1, paused: 0, credits: 12,
    recent: Array.from({ length: 12 }, (_, i) => ({ at: '2026-11-14T14:30:00Z', outcome: i === 0 ? 'acted' : 'quiet', credits: i === 0 ? 4 : 0, note: i === 0 ? 'replied to a new lead' : '' })),
  },
};

test('status reads the bill with GET and prints pace, today, totals, and the newest 10', async () => {
  const result = await run(['status', 'agent-1', '--days', '7'], { answer: () => ({ ok: true, status: 200, data: statusAnswer }) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [{ route: '/agent/agent-1/always-on?days=7', method: 'GET', token: 'test-secret' }]);
  const out = result.output;
  assert.equal(out[0], 'Scout is on. It checks in every 30 minutes.');
  assert.ok(out.includes('Today: 12 of 40 credits used, 28 left.'));
  assert.ok(out.includes('Today (since yesterday 4:00 PM): 14 check-ins.'), 'the server day runs midnight to midnight UTC, named in local time');
  assert.ok(out.includes('10 quiet, 3 did work, 1 failed.'));
  assert.ok(out.includes('Total: 12 credits ($0.12).'));
  assert.ok(!out.some((line) => /Our cost/.test(line)), 'owners never see our cost');
  const rows = out.slice(out.indexOf('Newest check-ins:') + 1);
  assert.equal(rows.length, 10);
  assert.match(rows[0], /^ {2}today \d+:\d\d [AP]M {2}\| {2}did work {2}\| {2}4 credits {2}\| {2}replied to a new lead$/);
  for (const row of rows.slice(1)) {
    assert.equal(row.split('  |  ').length, 3, 'a quiet row with an empty note has no note part');
    assert.doesNotMatch(row, /request failed/);
  }
  const week = await run(['status', 'agent-1', '--days', '7'], { answer: () => ({ ok: true, status: 200, data: { ...statusAnswer, bill: { ...statusAnswer.bill, days: 7 } } }) });
  assert.ok(week.output.includes('Last 7 days (since Nov 7, 4:00 PM): 14 check-ins.'));
});

test('status defaults to one day, shows staff cost only when the server sends it, and reads an agent that was never on', async () => {
  const staff = await run(['status', 'agent-1'], { answer: () => ({ ok: true, status: 200, data: { ...statusAnswer, bill: { ...statusAnswer.bill, raw_cost_usd: 0.0731 } } }) });
  assert.equal(staff.calls[0].route, '/agent/agent-1/always-on?days=1');
  assert.ok(staff.output.includes('Our cost: $0.07 (staff only).'));

  const never = {
    agent_id: 'agent-1', name: 'Scout', on: false, every_minutes: null, watch: null, daily_cap_credits: null, followups: true,
    next_check_in: null, last_check_in: null, today: { credits: 0, cap_credits: null, remaining_credits: null, paused_by_cap: false },
    bill: { days: 1, check_ins: 0, quiet: 0, acted: 0, failed: 0, paused: 0, credits: 0, recent: [] },
  };
  const off = await run(['status', 'agent-1'], { answer: () => ({ ok: true, status: 200, data: never }) });
  assert.equal(off.code, 0);
  assert.deepEqual(off.output, [
    'Scout is off. It does not check in on its own.',
    'Today: 0 credits used.',
    '',
    'Today (since yesterday 4:00 PM): no check-ins.',
    'Total: 0 credits ($0.00).',
  ]);
});

test('status says when the daily limit paused it, and rejects a bad --days', async () => {
  const capped = { ...statusAnswer, today: { credits: 40, cap_credits: 40, remaining_credits: 0, paused_by_cap: true } };
  const result = await run(['status', 'agent-1'], { answer: () => ({ ok: true, status: 200, data: capped }) });
  assert.ok(result.output.includes('It hit the daily limit, so it stopped for the day. It starts again today 4:00 PM (midnight UTC).'));
  for (const days of ['0', '31', 'week']) {
    const bad = await run(['status', 'agent-1', '--days', days]);
    assert.equal(bad.code, 1);
    assert.equal(bad.calls.length, 0);
    assert.match(bad.errors[0], /1 to 30/);
  }
});

test('off uses DELETE and says the bill is kept', async () => {
  const result = await run(['off', 'agent-1'], { answer: () => ({ ok: true, status: 200, data: { agent_id: 'agent-1', on: false } }) });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [{ route: '/agent/agent-1/always-on', method: 'DELETE', token: 'test-secret' }]);
  assert.deepEqual(result.output, [
    'agent-1 is off. It will not check in on its own anymore.',
    'Follow-ups it set for itself are canceled. The bill is kept.',
    'See the bill: atris agent always-on status agent-1',
  ]);
});

test('--json prints the server answer untouched for every verb', async () => {
  for (const [args, data] of [[['agent-1', '--json'], onAnswer], [['status', 'agent-1', '--json'], statusAnswer], [['off', 'agent-1', '--json'], { agent_id: 'agent-1', on: false }]]) {
    const result = await run(args, { answer: () => ({ ok: true, status: 200, data }) });
    assert.equal(result.code, 0);
    assert.equal(result.output.length, 1);
    assert.deepEqual(JSON.parse(result.output[0]), data);
  }
});

test('errors read in plain words: missing route, missing agent, not yours, signed out', async () => {
  const missingRoute = await run(['agent-1'], { answer: () => ({ ok: false, status: 404, data: { detail: 'Not Found' } }) });
  assert.equal(missingRoute.code, 1);
  assert.equal(missingRoute.errors[0], 'Could not turn on agent-1. This needs the newest Atris server. Try again in a few minutes.');

  const missingAgent = await run(['status', 'agent-1'], { answer: () => ({ ok: false, status: 404, data: { detail: 'Agent not found' } }) });
  assert.equal(missingAgent.errors[0], 'Could not read the bill for agent-1. Could not find an agent called agent-1. Check the name, or use its id.');

  const notYours = await run(['off', 'agent-1'], { answer: () => ({ ok: false, status: 403, data: { detail: 'Forbidden' } }) });
  assert.equal(notYours.errors[0], 'Could not turn off agent-1. agent-1 is not your agent. Only its owner can do this.');

  const refused = await run(['agent-1'], { answer: () => ({ ok: false, status: 401, data: {} }) });
  assert.match(refused.errors[0], /You are not signed in\. Run: atris login/);

  const signedOut = await run(['agent-1'], { token: '' });
  assert.equal(signedOut.code, 1);
  assert.equal(signedOut.calls.length, 0);
  assert.equal(signedOut.errors[0], 'You are not signed in. Run: atris login');
});

test('usage mistakes are caught before any request', async () => {
  for (const [args, pattern] of [
    [['status'], /name the agent/],
    [['off'], /name the agent/],
    [['a', 'b'], /takes one agent/],
    [['status', 'agent-1', '--every', '1h'], /--every is for turning it on/],
    [['agent-1', '--days', '3'], /--days is for reading the bill/],
    [['agent-1', '--frob'], /unknown option --frob/],
    [['agent-1', '--followups', '--no-followups'], /pick one/],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.calls.length, 0, args.join(' '));
    assert.match(result.errors[0], pattern, args.join(' '));
  }
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.output[0], /usage: atris agent always-on <agent>/);
});

test('a name saved by spawn resolves to its agent id, and the token never prints', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-always-on-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir };
  home.writeKeyFile('scout', { agent_id: 'saved/id', private_key: 'do-not-print' }, env);
  const result = await run(['scout'], { cwd: dir, env, answer: () => ({ ok: true, status: 200, data: { ...onAnswer, name: 'test-secret' } }) });
  assert.equal(result.calls[0].route, '/agent/saved%2Fid/always-on');
  assert.equal(result.output.at(-1), 'See the bill: atris agent always-on status scout');
  for (const line of result.output) assert.doesNotMatch(line, /test-secret|do-not-print/);
});

test('a locked job may read the bill or turn it off for free; turning it on is spend', () => {
  const cats = (args) => yesLock.analyze('atris', args).cats;
  assert.ok(cats(['agent', 'always-on', 'scout']).includes('spend'));
  assert.ok(cats(['agent', 'always-on', 'scout', '--every', '1h']).includes('spend'));
  assert.ok(!cats(['agent', 'always-on', 'status', 'scout']).includes('spend'));
  assert.ok(!cats(['agent', 'always-on', 'status', 'scout', '--days', '7']).includes('spend'));
  assert.ok(!cats(['agent', 'always-on', 'off', 'scout']).includes('spend'));
  assert.ok(!cats(['agent', 'always-on', '--help']).includes('spend'));
  assert.ok(!cats(['agent', 'always-on', '-h']).includes('spend'));
  assert.ok(!cats(['agent', 'always-on', 'help']).includes('spend'));
  // a word taken as a flag's value is never the verb or a help request
  assert.ok(cats(['agent', 'always-on', 'scout', '--every', '15m', '--cap', '2000', '--watch', 'help']).includes('spend'));
  assert.ok(cats(['agent', 'always-on', 'scout', '--watch', '-h']).includes('spend'));
  assert.ok(cats(['agent', 'always-on', '--business', 'status', 'scout']).includes('spend'));
  assert.ok(cats(['agent', 'always-on', '--business', 'off', 'scout']).includes('spend'));
  assert.ok(cats(['agent', 'spawn', 'researcher']).includes('spend'), 'other agent subs keep their old answer');
  assert.ok(!cats(['agent', 'spawns']).includes('spend'));
});

test('whenever the command would turn an agent on, the lock calls it spend', async () => {
  const spends = (args) => yesLock.analyze('atris', ['agent', 'always-on', ...args]).cats.includes('spend');
  for (const args of [
    ['scout'], ['scout', '--watch', 'help'], ['scout', '--watch', '-h'], ['scout', '--watch=help'], ['scout', '--watch=status'],
    ['--business', 'status', 'scout'], ['--business', 'off', 'scout'], ['--business=off', 'scout'], ['--json', 'scout'],
    ['scout', '--no-followups', 'status'], ['status', 'scout'], ['off', 'scout'], ['help'], ['-h'], ['--help'], ['--watch', '--help', 'scout'],
    ['--frob', 'status', 'scout'], ['scout', '-x'], ['--', 'scout'],
  ]) {
    const result = await run(args);
    const turnedOn = result.calls.some((call) => call.method === 'POST');
    if (turnedOn) assert.ok(spends(args), `the lock must hold: ${args.join(' ')}`);
  }
});

test('a refusal with no detail says the status, never "request failed"', async () => {
  const result = await run(['agent-1'], { answer: () => ({ ok: false, status: 400, data: '' }) });
  assert.equal(result.code, 1);
  assert.equal(result.errors[0], 'Could not turn on agent-1. The server said no (400).');
});
