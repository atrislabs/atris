'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a forbidden response is reported as unsuccessful', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-forbidden-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  const api = require('../utils/api');
  t.mock.method(api, 'httpRequest', async () => ({
    status: 403,
    headers: {},
    body: Buffer.from(JSON.stringify({ detail: 'Forbidden' })),
  }));
  const { designRequest } = require('../lib/design-api');

  const result = await designRequest('/design/jobs', { key: 'test-key' });
  assert.strictEqual(result.ok, false);
});
