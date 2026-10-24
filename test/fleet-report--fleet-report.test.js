'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep the real command and argument gate; replace only the external services.
async function runReport(args, respond) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-report-test-'));
  const original = {
    argv: process.argv, cwd: process.cwd(), env: { ...process.env },
    exit: process.exit, exitCode: process.exitCode,
    log: console.log, error: console.error,
  };
  const modulePaths = ['../utils/auth', '../utils/api', '../commands/fleet-report']
    .map((name) => require.resolve(name));
  const cached = modulePaths.map((name) => require.cache[name]);
  const logs = [];
  const errors = [];
  const calls = [];
  const stopped = new Error('intercepted process.exit');
  let exit;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    process.argv = ['node', 'atris', 'fleet-report', ...args];
    console.log = (line) => logs.push(line);
    console.error = (line) => errors.push(line);
    process.exit = (code) => { exit = code; throw stopped; };
    require.cache[modulePaths[0]] = {
      id: modulePaths[0], filename: modulePaths[0], loaded: true,
      exports: { loadCredentials: () => ({ token: 'fixture-token' }) },
    };
    require.cache[modulePaths[1]] = {
      id: modulePaths[1], filename: modulePaths[1], loaded: true,
      exports: { apiRequestJson: async (route, options) => {
        calls.push({ route, options });
        assert.strictEqual(options.token, 'fixture-token');
        return respond(route, options);
      } },
    };
    delete require.cache[modulePaths[2]];
    const { fleetReport } = require('../commands/fleet-report');
    try {
      await fleetReport();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    return { logs, errors, calls, exit: exit === undefined ? process.exitCode : exit };
  } finally {
    modulePaths.forEach((name, index) => {
      if (cached[index]) require.cache[name] = cached[index];
      else delete require.cache[name];
    });
    process.chdir(original.cwd);
    process.argv = original.argv;
    process.exit = original.exit;
    process.exitCode = original.exitCode;
    console.log = original.log;
    console.error = original.error;
    for (const key of Object.keys(process.env)) {
      if (!(key in original.env)) delete process.env[key];
    }
    Object.assign(process.env, original.env);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('fleetReport delivers a dated report and summarizes its scoreboard', async () => {
  const markdown = '# Report\nRevenue is growing.\n';
  const result = await runReport(['acme', '--account'], (route, options) => {
    switch (route) {
      case '/business/':
        return { ok: true, data: [{ id: 'biz', slug: 'acme', workspace_id: 'desk' }] };
      case '/business/biz/ai-computer/status':
        return { ok: true, data: { status: 'running', endpoint: 'fixture' } };
      case '/business/biz/daily-report':
        return { ok: true, data: { date: '2024-02-03', markdown, scoreboard: {
          revenue_mrr_usd: 120, compute_cost_usd: 2, ec2_cost_usd: 0.5,
          profit_daily_usd: 3,
        } } };
      case '/business/biz/workspaces/desk/terminal':
        assert.strictEqual(options.method, 'POST');
        assert.strictEqual(options.body.timeout, 30);
        assert.ok(options.body.command.includes(Buffer.from(markdown).toString('base64')));
        assert.ok(options.body.command.includes('/workspace/atris/reports/daily-2024-02-03.md'));
        assert.ok(options.body.command.includes('ln -sf'));
        return { ok: true, data: { stdout: 'WROTE:/workspace/atris/reports/daily-2024-02-03.md' } };
      default: throw new Error(`unexpected request: ${route}`);
    }
  });
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.exit, 0);
  assert.strictEqual(result.calls.length, 4);
  assert.deepStrictEqual(result.logs, [
    'Fleet daily report - 1 target(s)',
    '  acme: delivered /workspace/atris/reports/daily-2024-02-03.md | mrr $120 cost $2.50/d profit $3/d',
    'Fleet: $120 MRR, $3.00/day profit across 1 scoreboards',
    'Done: 1/1 delivered',
  ]);
});

test('fleetReport skips sleeping computers without fetching or writing reports', async () => {
  const result = await runReport(['--all-alive', '--account'], (route) => {
    if (route === '/business/') return { ok: true, data: [{ id: 'biz', name: 'Sleepy' }] };
    assert.strictEqual(route, '/business/biz/ai-computer/status');
    return { ok: true, data: { status: 'stopped' } };
  });
  assert.strictEqual(result.exit, 0);
  assert.strictEqual(result.calls.length, 2);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.logs, [
    'Fleet daily report - 1 target(s)',
    '  Sleepy: computer not alive, skipping',
    'Done: 0/1 delivered',
  ]);
});

test('fleetReport reports an unmatched business when the account has no businesses', async () => {
  const result = await runReport(['missing', '--account'], (route) => {
    assert.strictEqual(route, '/business/');
    return { ok: true, data: [] };
  });
  assert.strictEqual(result.exit, 1);
  assert.strictEqual(result.calls.length, 1);
  assert.deepStrictEqual(result.logs, []);
  assert.deepStrictEqual(result.errors, ['No business matching "missing"']);
});
