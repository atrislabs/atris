'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/site-deploy');

test('an existing site accepts HTTP 200 when enabling spa routing without a warning', async (t) => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-spa-200-'));
  t.after(() => fs.rmSync(site, { recursive: true, force: true }));
  const logs = [];
  const errors = [];
  const calls = [];
  const sitesUrl = 'https://sites.example.test/api/sites';

  const code = await run([
    site, '--name', 'spa-ok', '--spa', '--yes',
    '--api-base', 'https://sites.example.test',
  ], {
    loadCredentials: () => ({ token: 'test-token' }),
    renderApiKey: 'test-render-key',
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    httpRequest: async (url, options) => {
      calls.push([options.method, url, JSON.parse(options.body)]);
      if (url === sitesUrl && options.method === 'POST') {
        return { status: 409, body: '{"detail":"site already exists"}' };
      }
      if (url === `${sitesUrl}/spa-ok` && options.method === 'PATCH') {
        return { status: 200, body: '{"spa":true}' };
      }
      assert.equal(options.method, 'POST');
      assert.equal(url, 'https://api.render.com/v1/services/srv-culkutq3esus73cvqcg0/custom-domains');
      return { status: 201, body: '{}' };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [
    ['POST', sitesUrl, { slug: 'spa-ok', spa: true }],
    ['PATCH', `${sitesUrl}/spa-ok`, { spa: true }],
    ['POST', 'https://api.render.com/v1/services/srv-culkutq3esus73cvqcg0/custom-domains', { name: 'spa-ok.atris.ai' }],
  ]);
  assert.deepEqual(logs, [
    '\n  deploying 0 files to https://spa-ok.atris.ai',
    '  site spa-ok already exists',
    '  registered subdomain spa-ok.atris.ai',
    '\n  live at https://spa-ok.atris.ai',
  ]);
});
