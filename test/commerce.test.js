'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buyCommand } = require('../commands/buy');
const { transactionsCommand } = require('../commands/transactions');
const { ROLLOUT_MESSAGE, NOT_LOGGED_IN } = require('../lib/developer-api');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-commerce-'));
test.after(() => fs.rmSync(scratchCwd, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-29T18:00:00Z');

function capture() {
  const stdout = [];
  const stderr = [];
  return { stdout, stderr, log: (l) => stdout.push(String(l)), err: (l) => stderr.push(String(l)) };
}

function deps(io, handler) {
  const calls = [];
  return {
    calls,
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname, options) => {
      calls.push({ pathname, options });
      return handler(pathname, options);
    },
    now: () => NOW,
    log: io.log,
    err: io.err,
  };
}

test('buy and transactions are known commands listed in help', () => {
  assert.ok(knownCommands.includes('buy'));
  assert.ok(knownCommands.includes('transactions'));
  const run = spawnSync(process.execPath, [cliPath, 'help', '--all'], {
    cwd: scratchCwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /buy\s+- Quote a purchase/);
  assert.match(run.stdout, /transactions - List what you bought/);
});

test('buy quote posts flags as snake_case fields and says nothing is charged', async () => {
  const io = capture();
  const d = deps(io, () => ({
    ok: true,
    status: 200,
    data: {
      status: 'quoted', id: 'trq_abc', kind: 'trade',
      summary: 'Buy $25.00 of VTI through the person\'s own Robinhood account. Estimated $25.00. No Atris fee.',
      total_cents: 2500, fee_cents: 0, currency: 'usd', expires_at: '2026-09-29T18:10:00Z',
      approval: { who: 'human', how: 'text_confirm', text: 'Approve stages the order and returns a one-time phrase.' },
    },
  }));
  const code = await buyCommand(['quote', '--kind', 'trade', '--side', 'buy', '--symbol', 'VTI', '--dollars', '25', '--order-type', 'market'], d);
  assert.equal(code, 0, io.stderr.join('\n'));
  assert.equal(d.calls[0].pathname, '/commerce/quote');
  assert.equal(d.calls[0].options.method, 'POST');
  assert.equal(d.calls[0].options.token, 'tok');
  assert.equal(d.calls[0].options.retries, 0);
  assert.deepEqual(d.calls[0].options.body, { kind: 'trade', side: 'buy', symbol: 'VTI', dollars: 25, order_type: 'market' });
  const out = io.stdout.join('\n');
  assert.match(out, /Buy \$25\.00 of VTI/);
  assert.match(out, /Total: \$25\.00/);
  assert.match(out, /Atris fee: \$0\.00/);
  assert.match(out, /Expires: 2026-09-29T18:10:00Z \(in 10 min\)/);
  assert.match(out, /Nothing is charged until the person approves it themselves\./);
  assert.match(out, /atris buy approve trq_abc/);
});

test('buy quote --intent JSON merges with flags, and bad kinds never call the API', async () => {
  const io = capture();
  const d = deps(io, () => ({ ok: true, status: 200, data: { status: 'quoted', id: 'ord_1', summary: 'Tee' } }));
  const code = await buyCommand(['quote', '--intent', '{"kind":"shop","query":"navy tee"}', '--quantity', '2', '--json'], d);
  assert.equal(code, 0);
  assert.deepEqual(d.calls[0].options.body, { kind: 'shop', query: 'navy tee', quantity: 2 });
  assert.equal(JSON.parse(io.stdout.join('')).id, 'ord_1');

  const badIo = capture();
  const bad = deps(badIo, () => { throw new Error('should not be called'); });
  assert.equal(await buyCommand(['quote', '--kind', 'car', '--json'], bad), 1);
  assert.equal(bad.calls.length, 0);
  assert.match(JSON.parse(badIo.stdout.join('')).error, /--kind must be one of ticket, shop, trade, flight/);
});

test('buy approve prints the human step and never claims a charge', async () => {
  const io = capture();
  const d = deps(io, () => ({
    ok: true,
    status: 200,
    data: {
      status: 'pending_approval', id: 'ord_9', kind: 'ticket', message: 'Waiting for the person\'s approval in Link.',
      approval: { who: 'human', how: 'link_app', url: 'https://link.example/approve/1' },
      total_cents: 18400, fee_cents: 920, currency: 'usd',
    },
  }));
  const code = await buyCommand(['approve', 'ord_9', '--pick', '1', '--delivery-email', 'sam@example.com'], d);
  assert.equal(code, 0);
  assert.equal(d.calls[0].pathname, '/commerce/ord_9/approve');
  assert.equal(d.calls[0].options.method, 'POST');
  assert.equal(d.calls[0].options.retries, 0);
  assert.deepEqual(d.calls[0].options.body, { pick: '1', delivery_email: 'sam@example.com' });
  const out = io.stdout.join('\n');
  assert.match(out, /Approve in Link: https:\/\/link\.example\/approve\/1/);
  assert.match(out, /Total: \$184\.00/);
  assert.match(out, /Atris fee: \$9\.20/);
  assert.match(out, /Nothing has been charged yet/);
});

test('buy approve for a trade points to the texted confirm code, never prints one', async () => {
  const io = capture();
  const d = deps(io, () => ({
    ok: true,
    status: 200,
    data: {
      status: 'pending_approval', id: 'inv_7', kind: 'trade',
      message: 'Staged: buy $25.00 of VTI. Check your texts for the confirm code.',
      approval: { who: 'human', how: 'text_confirm',
        text: 'Check your texts. Atris sent the order and a one-time code to your own text thread.' },
      total_cents: 2500, fee_cents: 0, currency: 'usd', expires_at: '2026-09-29T18:05:00Z',
    },
  }));
  assert.equal(await buyCommand(['approve', 'trq_abc'], d), 0);
  assert.deepEqual(d.calls[0].options.body, {});
  const out = io.stdout.join('\n');
  assert.match(out, /We texted you a confirm code\. Reply to that text to place the trade\./);
  assert.doesNotMatch(out, /yes \d{4}/);
  assert.match(out, /in 5 min/);
  assert.match(out, /Nothing has been charged yet/);
});

test('buy approve refused and needs_setup say nothing was charged', async () => {
  const io = capture();
  const d = deps(io, () => ({
    ok: true,
    status: 200,
    data: { status: 'needs_setup', message: 'Connect your Link wallet first, then approve again. Nothing was charged.',
      approval: { who: 'human', how: 'connect_link', url: 'https://link.example/connect' } },
  }));
  assert.equal(await buyCommand(['approve', 'ord_2'], d), 0);
  assert.match(io.stdout.join('\n'), /Connect Link first: https:\/\/link\.example\/connect/);

  const io2 = capture();
  const d2 = deps(io2, () => ({ ok: true, status: 200, data: { status: 'refused', message: 'That quote is over 30 minutes old.' } }));
  assert.equal(await buyCommand(['approve', 'ord_2'], d2), 0);
  assert.match(io2.stdout.join('\n'), /Nothing was charged\./);
});

test('buy status reads one id, and a bare 404 means the backend is not deployed', async () => {
  const io = capture();
  const d = deps(io, () => ({
    ok: true,
    status: 200,
    data: { id: 'ord_9', kind: 'ticket', state: 'pending_approval', what: 'Phish, 2 tickets', amount_cents: 18400,
      currency: 'usd', fee_payment_url: 'https://pay.example/fee',
      approval: { who: 'human', how: 'link_app', url: 'https://link.example/a' } },
  }));
  assert.equal(await buyCommand(['status', 'ord_9'], d), 0);
  assert.equal(d.calls[0].pathname, '/commerce/ord_9');
  assert.equal(d.calls[0].options.method, 'GET');
  const out = io.stdout.join('\n');
  assert.match(out, /PENDING_APPROVAL/);
  assert.match(out, /Amount: \$184\.00/);
  assert.match(out, /Approve in Link: https:\/\/link\.example\/a/);
  assert.match(out, /Pay the Atris fee: https:\/\/pay\.example\/fee/);

  const io404 = capture();
  const d404 = deps(io404, () => ({ ok: false, status: 404, data: { detail: 'Not Found' }, error: 'Not Found' }));
  assert.equal(await buyCommand(['status', 'ord_9', '--json'], d404), 1);
  assert.equal(JSON.parse(io404.stdout.join('')).error, ROLLOUT_MESSAGE);

  const ioEnv = capture();
  const dEnv = deps(ioEnv, () => ({
    ok: false, status: 404,
    data: { error: { message: 'Not found.', type: 'not_found_error' }, atris: { request_id: 'req_1' } },
  }));
  assert.equal(await buyCommand(['status', 'ord_404'], dEnv), 1);
  assert.equal(ioEnv.stderr.join(''), 'Not found.');
});

test('buy without login is one sentence', async () => {
  const io = capture();
  const code = await buyCommand(['status', 'ord_1'], { loadCredentials: () => null, log: io.log, err: io.err });
  assert.equal(code, 1);
  assert.equal(io.stderr.join(''), NOT_LOGGED_IN);
});

test('transactions builds the query and prints a compact table', async () => {
  const io = capture();
  const d = deps(io, () => ({
    ok: true,
    status: 200,
    data: {
      transactions: [
        { id: 'ord_1', kind: 'ticket', when: '2026-09-20T19:30:00+00:00', what: 'Phish at MSG, 2 tickets', amount_cents: 18400, currency: 'usd', state: 'done' },
        { id: 'inv_2', kind: 'trade', when: '2026-09-19T14:00:00+00:00', what: 'Buy $25.00 of VTI', amount_cents: 2500, currency: 'usd', state: 'failed' },
      ],
      count: 2,
      sources: { purchases: 'ok', trades: 'ok', wallet: 'failed' },
    },
  }));
  const code = await transactionsCommand(['--since', '2026-09-01', '--kind', 'ticket,trade', '--limit', '10', '--include-quotes'], d);
  assert.equal(code, 0, io.stderr.join('\n'));
  assert.equal(d.calls[0].pathname, '/transactions?since=2026-09-01&kinds=ticket%2Ctrade&limit=10&include_quotes=true');
  assert.equal(d.calls[0].options.method, 'GET');
  const out = io.stdout.join('\n');
  assert.match(out, /^WHEN\s+KIND\s+WHAT\s+AMOUNT\s+STATE/);
  assert.match(out, /2026-09-20 19:30\s+ticket\s+Phish at MSG, 2 tickets\s+\$184\.00\s+done/);
  assert.match(out, /Partial list: could not load wallet\./);
});

test('transactions --json passes the payload through; bad flags never call the API', async () => {
  const io = capture();
  const d = deps(io, () => ({ ok: true, status: 200, data: { transactions: [], count: 0, sources: { purchases: 'ok' } } }));
  assert.equal(await transactionsCommand(['--json'], d), 0);
  assert.equal(d.calls[0].pathname, '/transactions');
  assert.deepEqual(JSON.parse(io.stdout.join('')), { ok: true, transactions: [], count: 0, sources: { purchases: 'ok' } });

  for (const args of [['--since', 'last week'], ['--kind', 'car'], ['--limit', '500']]) {
    const badIo = capture();
    const bad = deps(badIo, () => { throw new Error('should not be called'); });
    assert.equal(await transactionsCommand(args, bad), 1, args.join(' '));
    assert.equal(bad.calls.length, 0);
  }
});

test('transactions with no rows says so', async () => {
  const io = capture();
  const d = deps(io, () => ({ ok: true, status: 200, data: { transactions: [], count: 0, sources: {} } }));
  assert.equal(await transactionsCommand([], d), 0);
  assert.equal(io.stdout.join('\n'), 'No transactions yet.');
});
