'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  normalizeBalance,
  formatDollars,
  checkoutUrl,
  parseAmountUsd,
  ROLLOUT_MESSAGE,
  NOT_LOGGED_IN,
} = require('../lib/developer-api');
const { balanceCommand } = require('../commands/balance');
const { usageCommand } = require('../commands/usage');
const { apiKeyCommand, parseApiKeyArgs } = require('../commands/api-key');
const { topupCommand } = require('../commands/topup');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    log: (line) => stdout.push(String(line)),
    err: (line) => stderr.push(String(line)),
  };
}

function cliEnv(extra = {}) {
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ...extra,
  };
  delete env.ATRIS_TOKEN;
  delete env.ATRIS_PROFILE;
  return env;
}

function runCli(args, extraEnv) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: cliEnv(extraEnv),
  });
}

test('knownCommands includes the four developer api verbs', () => {
  for (const name of ['balance', 'usage', 'api-key', 'topup']) {
    assert.ok(knownCommands.includes(name), name);
  }
});

test('help lists balance, usage, api-key, and topup', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /balance\s+- Show credit balance in dollars/);
  assert.match(run.stdout, /usage\s+- Show developer API usage/);
  assert.match(run.stdout, /api-key\s+- Create, list, rotate, or revoke a developer API key/);
  assert.match(run.stdout, /topup\s+- Buy credits and print a Stripe checkout URL/);
});

test('command help is workspace-free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dev-api-help-'));
  try {
    for (const args of [['balance', '--help'], ['usage', '--help'], ['api-key', '--help'], ['topup', '--help']]) {
      const run = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: cliEnv({ HOME: path.join(dir, 'home') }),
      });
      assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr || run.stdout}`);
      assert.match(run.stdout, /usage: atris /);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeBalance shows dollars from credits/100', () => {
  const balance = normalizeBalance({ balance: 1250, lifetime_purchased: 2000, lifetime_spent: 750 });
  assert.equal(balance.dollars, 12.5);
  assert.equal(balance.credits, 1250);
  assert.equal(formatDollars(balance.dollars), '$12.50');
  assert.equal(normalizeBalance({ balance: 100, balance_usd: 1.5 }).dollars, 1.5);
});

test('balance --json prints dollars and credits', async () => {
  const io = capture();
  const code = await balanceCommand(['--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/credits/balance');
      assert.equal(options.method, 'GET');
      assert.equal(options.token, 'tok');
      return { ok: true, status: 200, data: { balance: 2500, balance_usd: 25, lifetime_purchased: 2500, lifetime_spent: 0 } };
    },
    log: io.log,
    err: io.err,
  });
  assert.equal(code, 0);
  const payload = JSON.parse(io.stdout.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.dollars, 25);
  assert.equal(payload.credits, 2500);
  assert.equal(io.stderr.length, 0);
});

test('balance without login is one sentence', async () => {
  const io = capture();
  const code = await balanceCommand([], {
    loadCredentials: () => null,
    log: io.log,
    err: io.err,
  });
  assert.equal(code, 1);
  assert.equal(io.stderr.join(''), NOT_LOGGED_IN);
});

test('usage 404 prints the rollout sentence', async () => {
  const io = capture();
  const code = await usageCommand(['--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async () => ({ ok: false, status: 404, error: 'Not Found' }),
    log: io.log,
    err: io.err,
  });
  assert.equal(code, 1);
  const payload = JSON.parse(io.stdout.join(''));
  assert.equal(payload.error, ROLLOUT_MESSAGE);
  assert.equal(payload.status, 404);
});

test('api-key create and list 404s are graceful', async () => {
  const createIo = capture();
  const createCode = await apiKeyCommand(['create', 'cli', '--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/developer/create-key');
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.body, { name: 'cli' });
      return { ok: false, status: 404, error: 'missing' };
    },
    log: createIo.log,
    err: createIo.err,
  });
  assert.equal(createCode, 1);
  assert.equal(JSON.parse(createIo.stdout.join('')).error, ROLLOUT_MESSAGE);

  const listIo = capture();
  const listCode = await apiKeyCommand(['list', '--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname) => {
      assert.equal(pathname, '/developer/keys');
      return { ok: false, status: 404, error: 'missing' };
    },
    log: listIo.log,
    err: listIo.err,
  });
  assert.equal(listCode, 1);
  assert.equal(JSON.parse(listIo.stdout.join('')).error, ROLLOUT_MESSAGE);
});

test('api-key rotate and revoke call agent routes', async () => {
  const rotateIo = capture();
  const rotateCode = await apiKeyCommand(['rotate', 'agent-1', '--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/agent/agent-1/rotate-api-key');
      assert.equal(options.method, 'POST');
      return { ok: true, status: 200, data: { agent_id: 'agent-1', new_api_key: 'sk_live_new' } };
    },
    log: rotateIo.log,
    err: rotateIo.err,
  });
  assert.equal(rotateCode, 0);
  assert.equal(JSON.parse(rotateIo.stdout.join('')).new_api_key, 'sk_live_new');

  const revokeIo = capture();
  const revokeCode = await apiKeyCommand(['revoke', 'agent-1', '--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/agent/agent-1/api-key');
      assert.equal(options.method, 'DELETE');
      return { ok: true, status: 200, data: { agent_id: 'agent-1', message: 'API key revoked.' } };
    },
    log: revokeIo.log,
    err: revokeIo.err,
  });
  assert.equal(revokeCode, 0);
  assert.equal(JSON.parse(revokeIo.stdout.join('')).ok, true);
});

test('parseApiKeyArgs keeps --name off the action', () => {
  const parsed = parseApiKeyArgs(['create', '--name', 'studio', '--cap', '25', '--json']);
  assert.equal(parsed.action, 'create');
  assert.equal(parsed.name, 'studio');
  assert.equal(parsed.cap, 25);
});

test('topup --json prints checkout url and does not open a browser', async () => {
  let opened = 0;
  const io = capture();
  const code = await topupCommand(['25', '--json'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async (pathname, options) => {
      assert.equal(pathname, '/credits/purchase');
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.body, { amount_usd: 25 });
      return { ok: true, status: 200, data: { checkout_url: 'https://checkout.stripe.com/c/pay/cs_test', credits_to_add: 2500 } };
    },
    openBrowser: () => { opened += 1; },
    isTty: true,
    log: io.log,
    err: io.err,
  });
  assert.equal(code, 0);
  const payload = JSON.parse(io.stdout.join(''));
  assert.equal(payload.checkout_url, 'https://checkout.stripe.com/c/pay/cs_test');
  assert.equal(payload.amount_usd, 25);
  assert.equal(opened, 0);
});

test('topup text mode opens the browser on a tty', async () => {
  let opened = '';
  const io = capture();
  const code = await topupCommand(['10'], {
    loadCredentials: () => ({ token: 'tok' }),
    apiRequestJson: async () => ({
      ok: true,
      status: 200,
      data: { checkout_url: 'https://checkout.stripe.com/pay/cs_live', credits_to_add: 1000 },
    }),
    openBrowser: (url) => { opened = url; },
    isTty: true,
    log: io.log,
    err: io.err,
  });
  assert.equal(code, 0);
  assert.match(io.stdout.join(''), /https:\/\/checkout\.stripe\.com\/pay\/cs_live/);
  assert.equal(opened, 'https://checkout.stripe.com/pay/cs_live');
});

test('parseAmountUsd rejects out-of-range values', () => {
  assert.deepEqual(parseAmountUsd([]), { ok: true, amount: 10 });
  assert.equal(parseAmountUsd(['4']).ok, false);
  assert.equal(parseAmountUsd(['$25']).amount, 25);
});

test('checkoutUrl reads checkout_url or url', () => {
  assert.equal(checkoutUrl({ checkout_url: 'https://pay.example/1' }), 'https://pay.example/1');
  assert.equal(checkoutUrl({ url: 'https://pay.example/2' }), 'https://pay.example/2');
});
