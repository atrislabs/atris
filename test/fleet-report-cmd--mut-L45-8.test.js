'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a woken computer that comes up running with an endpoint gets its report', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mut45-'));
  const original = {
    argv: process.argv, cwd: process.cwd(), env: { ...process.env },
    exit: process.exit, exitCode: process.exitCode,
    log: console.log, error: console.error,
  };
  const authPath = require.resolve('../utils/auth');
  const apiPath = require.resolve('../utils/api');
  const cachedAuth = require.cache[authPath];
  const cachedApi = require.cache[apiPath];
  const logs = [];
  const errors = [];
  const calls = [];
  const stopped = new Error('intercepted process.exit');
  let exit;
  let statusCalls = 0;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = home;
    process.chdir(home);
    process.argv = ['node', 'atris', 'x', 'acme', '--account', '--wake'];
    console.log = (line) => logs.push(line);
    console.error = (line) => errors.push(line);
    process.exit = (code) => { exit = code; throw stopped; };
    require.cache[authPath] = {
      id: authPath, filename: authPath, loaded: true,
      exports: { loadCredentials: () => ({ token: 'fixture-token' }) },
    };
    require.cache[apiPath] = {
      id: apiPath, filename: apiPath, loaded: true,
      exports: { apiRequestJson: async (route) => {
        calls.push(route);
        if (route === '/business/') {
          return { ok: true, data: [{ id: 'biz', slug: 'acme', workspace_id: 'desk' }] };
        }
        if (route.endsWith('/ai-computer/status')) {
          statusCalls += 1;
          if (statusCalls === 1) return { ok: true, data: { status: 'stopped' } };
          return { ok: true, data: { status: 'running', endpoint: 'fixture' } };
        }
        if (route.endsWith('/daily-report')) {
          return { ok: true, data: { date: '2024-02-03', markdown: '# R', scoreboard: { revenue_mrr_usd: 5 } } };
        }
        return { ok: true, data: { stdout: 'WROTE:/x.md' } };
      } },
    };
    for (const key of Object.keys(require.cache)) {
      const entry = require.cache[key];
      if (entry && entry.exports && typeof entry.exports.fleetReport === 'function') {
        delete require.cache[key];
      }
    }
    const { fleetReport } = require('../commands/fleet-report');
    try {
      await fleetReport();
    } catch (error) {
      if (error !== stopped) throw error;
    }
    const code = exit === undefined ? process.exitCode : exit;
    assert.ok(logs.includes('awake'), `expected wake success, saw: ${JSON.stringify(logs)}`);
    assert.ok(
      calls.some((route) => route.endsWith('/terminal')),
      `expected report delivery, saw calls: ${JSON.stringify(calls)} exit ${code}`,
    );
  } finally {
    if (cachedAuth) require.cache[authPath] = cachedAuth;
    else delete require.cache[authPath];
    if (cachedApi) require.cache[apiPath] = cachedApi;
    else delete require.cache[apiPath];
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
  }
});
