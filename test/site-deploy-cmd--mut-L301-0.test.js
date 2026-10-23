'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/site-deploy');

test('spa creation reports a failed retry instead of announcing a successful deploy', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-spa-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const errors = [];
  const logs = [];
  const sitesUrl = 'https://deploy.example/api/sites';

  const code = await run([
    dir, '--name', 'spa-retry', '--spa', '--yes',
    '--api-base', 'https://deploy.example',
  ], {
    homedir: () => dir,
    loadCredentials: () => ({ token: 'test-token' }),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    httpRequest: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      if (calls.length === 1) {
        return { status: 422, body: JSON.stringify({ detail: 'unknown field spa' }) };
      }
      return { status: 503, body: JSON.stringify({ detail: 'site storage unavailable' }) };
    },
  });

  assert.deepEqual(errors, [
    '  deploy failed: POST https://deploy.example/api/sites failed (503): site storage unavailable',
  ]);
  assert.equal(code, 1);
  assert.deepEqual(logs, ['\n  deploying 0 files to https://spa-retry.atris.ai']);
  assert.deepEqual(calls, [
    { url: sitesUrl, method: 'POST', body: { slug: 'spa-retry', spa: true } },
    { url: sitesUrl, method: 'POST', body: { slug: 'spa-retry' } },
  ]);
});
