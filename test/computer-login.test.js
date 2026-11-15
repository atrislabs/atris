'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computerLogin, parseLoginArgs, findComputer } = require('../commands/computer-login');
const { runComputer } = require('../commands/computer');

const TOKEN = `sk-ant-oat01-${'a1B2_c3-'.repeat(8)}`;
const COMPUTERS = [
  { business_id: 'biz-a', name: 'Alpha', slug: 'alpha', linked: false, engine: null, shared_sign_in: false },
  { business_id: 'biz-b', name: 'Beta', slug: 'beta', linked: true, engine: 'claude', shared_sign_in: false },
  { business_id: 'biz-c', name: 'Gamma', slug: 'gamma', linked: true, engine: 'claude', shared_sign_in: true },
];
const OLD_RUN = { execution_id: 'run-old', status: 'completed', billing_mode: 'business_pays', on_subscription: false };
const GOOD_RUN = { execution_id: 'run-new', status: 'completed', billing_mode: 'claude_app', on_subscription: true };

function harness({ responses = {}, signIn = { credential: TOKEN }, binding = null, before = OLD_RUN, after = GOOD_RUN, reply = 'OK' } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  let lastRunCalls = 0;
  const deps = {
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    loadCredentials: async () => ({ token: 'atris-session' }),
    readBusinessBinding: () => binding,
    claudeSignIn: () => signIn,
    codexSignIn: () => signIn,
    runTest: () => ({ ok: true, reply }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      const key = `${options.method} ${pathname.split('?')[0]}`;
      if (responses[key]) return responses[key];
      if (key === 'GET /ai-computer/subscription') return { ok: true, status: 200, data: { computers: COMPUTERS } };
      if (key === 'POST /ai-computer/subscription/link') {
        const ids = options.body.business_id ? [options.body.business_id] : COMPUTERS.map((item) => item.business_id);
        return { ok: true, status: 200, data: { linked: ids.map((business_id) => ({ business_id, engine: options.body.engine })), failed: [] } };
      }
      if (key === 'POST /ai-computer/subscription/unlink') return { ok: true, status: 200, data: { unlinked: ['biz-b'], failed: [] } };
      if (key === 'GET /ai-computer/subscription/last-run') {
        lastRunCalls += 1;
        return { ok: true, status: 200, data: { run: lastRunCalls === 1 ? before : after } };
      }
      throw new Error(`unexpected call ${key}`);
    },
  };
  return { deps, calls, out, err, text: () => [...out, ...err].join('\n') };
}

const linkCall = (h) => h.calls.find((call) => call.pathname === '/ai-computer/subscription/link');

test('one command signs in and covers every computer you own', async () => {
  const h = harness();
  const code = await computerLogin([], h.deps);

  assert.equal(code, 0);
  assert.deepEqual(linkCall(h).options.body, { engine: 'claude', credential: TOKEN });
  assert.match(h.text(), /on 3 computers: Alpha, Beta, Gamma/);
  assert.match(h.text(), /only on runs you start/);
});

test('the sign-in is never printed', async () => {
  const h = harness({ binding: { business_id: 'biz-a' } });
  await computerLogin([], h.deps);

  assert.equal(h.text().includes(TOKEN), false);
});

test('inside a computer folder it proves the run used the subscription', async () => {
  const h = harness({ binding: { business_id: 'biz-a', slug: 'alpha-local-name' } });
  const code = await computerLogin([], h.deps);

  assert.equal(code, 0);
  assert.match(h.text(), /Proven: that job ran on your claude subscription/);
});

test('a test run paid the normal way is reported as not working', async () => {
  const h = harness({
    binding: { business_id: 'biz-a' },
    after: { execution_id: 'run-new', status: 'completed', billing_mode: 'business_pays', on_subscription: false },
  });
  const code = await computerLogin([], h.deps);

  assert.equal(code, 2);
  assert.match(h.text(), /Not working: that job was paid as "business_pays"/);
});

test('the same record as before the test does not count as proof', async () => {
  const stale = { execution_id: 'run-old', status: 'completed', billing_mode: 'claude_app', on_subscription: true };
  const h = harness({ binding: { business_id: 'biz-a' }, before: stale, after: stale });
  const code = await computerLogin([], h.deps);

  assert.equal(code, 2);
  assert.match(h.text(), /no new record/);
});

test('a first ever run counts as new', async () => {
  const h = harness({ binding: { business_id: 'biz-a' }, before: null });

  assert.equal(await computerLogin([], h.deps), 0);
});

test('a subscription run that failed is not called proven', async () => {
  const h = harness({ binding: { business_id: 'biz-a' }, after: { ...GOOD_RUN, status: 'failed' } });
  const code = await computerLogin([], h.deps);

  assert.equal(code, 2);
  assert.match(h.text(), /did not finish cleanly \(failed\)/);
  assert.doesNotMatch(h.text(), /Proven/);
});

test('a subscription run with no OK reply is not called proven', async () => {
  const h = harness({ binding: { business_id: 'biz-a' }, reply: 'Error: signed out' });

  assert.equal(await computerLogin([], h.deps), 2);
  assert.doesNotMatch(h.text(), /Proven/);
});

test('a computer with the older shared sign-in gets an honest caveat', async () => {
  const h = harness();
  const code = await computerLogin(['--check', '--business', 'gamma'], h.deps);

  assert.equal(code, 0);
  assert.match(h.text(), /cannot tell the two apart/);
  assert.doesNotMatch(h.text(), /Proven/);
});

test('--business limits the sign-in to one computer you own', async () => {
  const h = harness();
  const code = await computerLogin(['--business', 'Alpha', '--no-test'], h.deps);

  assert.equal(code, 0);
  assert.equal(linkCall(h).options.body.business_id, 'biz-a');
});

test('--business typed before login still limits it to that one computer', async () => {
  const h = harness();
  const before = process.exitCode;
  const code = await runComputer(['--business', 'Alpha', 'login', '--no-test'], h.deps);
  process.exitCode = before;

  assert.equal(code, 0);
  assert.equal(linkCall(h).options.body.business_id, 'biz-a');
});

test('--business typed before login --unlink removes it from that one computer only', async () => {
  const h = harness();
  const before = process.exitCode;
  await runComputer(['-b', 'beta', 'login', '--unlink'], h.deps);
  process.exitCode = before;

  const unlink = h.calls.find((call) => call.pathname.endsWith('/unlink'));
  assert.deepEqual(unlink.options.body, { business_id: 'biz-b' });
});

test('a computer you do not own stops before any sign-in', async () => {
  let signedIn = false;
  const h = harness();
  h.deps.claudeSignIn = () => { signedIn = true; return { credential: TOKEN }; };
  const code = await computerLogin(['--business', 'someone-else'], h.deps);

  assert.equal(code, 1);
  assert.equal(signedIn, false);
  assert.match(h.text(), /do not own a computer named "someone-else"/);
});

test('a failed sign-in changes nothing', async () => {
  const h = harness({ signIn: { error: 'No sign-in came back from Claude.' } });
  const code = await computerLogin([], h.deps);

  assert.equal(code, 1);
  assert.equal(linkCall(h), undefined);
  assert.match(h.text(), /Nothing was changed/);
});

test('computers the server could not reach are named, not hidden', async () => {
  const h = harness({
    responses: {
      'POST /ai-computer/subscription/link': {
        ok: true, status: 200, data: { linked: [{ business_id: 'biz-a', engine: 'claude' }], failed: ['biz-b'] },
      },
    },
  });
  const code = await computerLogin(['--no-test'], h.deps);

  assert.equal(code, 1);
  assert.match(h.text(), /on 1 computer: Alpha/);
  assert.match(h.text(), /could not be added to 1: Beta/);
});

test('a server error on the link does not claim nothing changed', async () => {
  const h = harness({ responses: { 'POST /ai-computer/subscription/link': { ok: false, status: 500, error: 'boom' } } });
  const code = await computerLogin(['--no-test'], h.deps);

  assert.equal(code, 1);
  assert.doesNotMatch(h.text(), /Nothing was changed/);
  assert.match(h.text(), /Some computers may have it/);
});

test('a refusal on the link says nothing changed', async () => {
  const h = harness({ responses: { 'POST /ai-computer/subscription/link': { ok: false, status: 403, error: 'You can only link a subscription to a computer you own.' } } });
  const code = await computerLogin(['--no-test'], h.deps);

  assert.equal(code, 1);
  assert.match(h.text(), /Nothing was changed/);
});

test('an account that is not allowed hears so before signing in', async () => {
  let signedIn = false;
  const h = harness({ responses: { 'GET /ai-computer/subscription': { ok: false, status: 403, error: 'Admin privileges required' } } });
  h.deps.claudeSignIn = () => { signedIn = true; return { credential: TOKEN }; };
  const code = await computerLogin([], h.deps);

  assert.equal(code, 1);
  assert.equal(signedIn, false);
});

test('a server without the feature says it needs a deploy', async () => {
  const h = harness({ responses: { 'GET /ai-computer/subscription': { ok: false, status: 404, error: 'Not Found' } } });
  const code = await computerLogin([], h.deps);

  assert.equal(code, 1);
  assert.match(h.text(), /needs the latest deploy/);
});

test('--status lists computers without signing in', async () => {
  const h = harness();
  const code = await computerLogin(['--status'], h.deps);

  assert.equal(code, 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.text(), /Alpha\s+no subscription/);
  assert.match(h.text(), /Beta\s+claude subscription/);
});

test('--check proves an already signed-in computer without a new sign-in', async () => {
  let signedIn = false;
  const h = harness();
  h.deps.claudeSignIn = () => { signedIn = true; return { credential: TOKEN }; };
  const code = await computerLogin(['--check', '--business', 'beta'], h.deps);

  assert.equal(code, 0);
  assert.equal(signedIn, false);
  assert.match(h.text(), /Proven/);
});

test('--check on a computer with no subscription says to sign in first', async () => {
  const h = harness();
  const code = await computerLogin(['--check', '--business', 'alpha'], h.deps);

  assert.equal(code, 1);
  assert.match(h.text(), /has no subscription yet/);
});

test('--unlink removes it', async () => {
  const h = harness();
  const code = await computerLogin(['--unlink', '--business', 'beta'], h.deps);

  assert.equal(code, 0);
  const unlink = h.calls.find((call) => call.pathname.endsWith('/unlink'));
  assert.deepEqual(unlink.options.body, { business_id: 'biz-b' });
});

test('codex is chosen by name and an unknown option is refused', async () => {
  assert.equal(parseLoginArgs(['codex']).engine, 'codex');
  assert.equal(parseLoginArgs([]).engine, 'claude');
  assert.match(parseLoginArgs(['--nope']).error, /unknown option/);
  assert.equal(findComputer(COMPUTERS, 'BETA').business_id, 'biz-b');
});

test('the computer help does not list login: it works for anyone who knows it, and is not advertised', async () => {
  const lines = [];
  const realLog = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    await runComputer(['--help'], {});
  } finally {
    console.log = realLog;
  }
  const modes = lines.filter((line) => /^\s{2}\S/.test(line));
  assert.ok(modes.some((line) => /^\s{2}setup\s/.test(line)), 'help printed its list');
  assert.equal(modes.some((line) => /^\s{2}login\s/.test(line)), false);
});
