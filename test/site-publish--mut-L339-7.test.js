'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../lib/site-publish');

test('a successful publish does not follow its Location header', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-location-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>');

  const code = await run([dir, '--slug', 'created-site', '--no-claim'], {
    apiBase: 'https://api.example.test/api',
    loadCredentials: () => ({ token: 'test-token' }),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ Location: 'https://created-site.example.test/' }),
      json: async () => ({
        publish_id: 'published-site',
        pages: 1,
        verified: true,
        urls: { site: 'https://created-site.example.test/' },
      }),
    }),
    log: () => {},
    error: () => {},
  });

  assert.equal(code, 0);
});
