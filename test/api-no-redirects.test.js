'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { apiRequestJson } = require('../utils/api');
const { runBoundedPrRound } = require('../lib/computer-pr-bounded');

test('bounded real HTTP starts never replay bodies across same-origin redirects', async t => {
  for (const status of [301, 302, 307, 308]) {
    await t.test(String(status), async () => {
      const seen = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', data => { body += data; });
        req.on('end', () => {
          seen.push({ path: req.url, method: req.method, body });
          if (req.url === '/replay') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ execution_id: 'unsafe-replay' }));
          } else {
            res.writeHead(status, { Location: '/replay' }); res.end('{}');
          }
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const old = process.env.ATRIS_API_URL;
      process.env.ATRIS_API_URL = `http://127.0.0.1:${server.address().port}`;
      try {
        const result = await runBoundedPrRound({ request: apiRequestJson, token: 'fixture-only',
          ctx: { businessId: 'fixture-business', workspaceId: 'fixture-workspace' },
          startOptions: { body: { task: 'fixture payload' } }, deadlineAt: Date.now() + 3000,
          saveReceipt: () => '/fixture-only', cancellationGraceMs: 30 });
        assert.equal(result.receipt.status, 'start_outcome_unknown');
        assert.equal(result.receipt.execution_id, null);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].method, 'POST');
        assert.equal(seen[0].body, JSON.stringify({ task: 'fixture payload' }));
        assert.equal(seen[0].path, '/business/fixture-business/chat/subscription-only');
        // Legacy opt-out remains unchanged: same-origin redirect still follows.
        seen.length = 0;
        const legacy = await apiRequestJson('/legacy', { method: 'POST', body: {}, retries: 0 });
        assert.equal(legacy.status, 200);
        assert.equal(seen.length, 2);
        assert.equal(seen[1].path, '/replay');
      } finally {
        if (old === undefined) delete process.env.ATRIS_API_URL; else process.env.ATRIS_API_URL = old;
        await new Promise(resolve => server.close(resolve));
      }
    });
  }
});

test('bounded real HTTP cancellation redirect stays unconfirmed without body replay', async () => {
  const seen = [];
  const controller = new AbortController();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ path: req.url, method: req.method });
      if (req.url.endsWith('/subscription-only')) {
        controller.abort();
        res.end(JSON.stringify({ execution_id: 'fixture-execution' }));
      } else if (req.url.includes('/cancel-strict?')) {
        res.writeHead(307, { Location: '/unsafe-global-stop' }); res.end('{}');
      } else { res.end(JSON.stringify({ status: 'running', events: [] })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.ATRIS_API_URL;
  process.env.ATRIS_API_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runBoundedPrRound({ request: apiRequestJson, token: 'fixture-only',
      ctx: { businessId: 'fixture-business', workspaceId: 'fixture-workspace' },
      startOptions: { body: {} }, deadlineAt: Date.now() + 3000, signal: controller.signal,
      saveReceipt: () => '/fixture-only', cancellationGraceMs: 80 });
    assert.equal(result.receipt.status, 'cancellation_unconfirmed');
    assert.equal(result.receipt.cancellation_acknowledged, false);
    assert.equal(result.receipt.terminal_status_observed, false);
    assert.equal(seen.filter(r => r.path.includes('/cancel-strict?')).length, 1);
    assert.equal(seen.filter(r => r.path === '/unsafe-global-stop').length, 0);
    assert.equal(seen.filter(r => r.method === 'POST').length, 2);
  } finally {
    if (old === undefined) delete process.env.ATRIS_API_URL; else process.env.ATRIS_API_URL = old;
    await new Promise(resolve => server.close(resolve));
  }
});
