'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../lib/site-publish');

test('publishing accepts the strict security profile and sends it to the API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-profile-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>');
  let sentProfile;
  const code = await run([dir, '--slug', 'strict-example', '--profile', 'strict', '--no-claim'], {
    loadCredentials: () => ({ token: 'test-token' }),
    fetch: async (_url, options) => {
      sentProfile = JSON.parse(options.body).csp_profile;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          publish_id: 'pub-strict',
          pages: 1,
          verified: true,
          urls: { site: 'https://strict-example.atris.ai/' },
        }),
      };
    },
    log: () => {},
    error: () => {},
  });
  assert.equal(sentProfile, 'strict');
  assert.equal(code, 0);
});
