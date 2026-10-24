'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-error-detail-'));
const savedHome = process.env.HOME;
process.env.HOME = home;
const api = require('../utils/api');

test('failed requests expose the structured error detail', async (t) => {
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  t.mock.method(api, 'httpRequest', async () => ({
    status: 402,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ detail: 'insufficient credits' })),
  }));
  const { designRequest } = require('../lib/design-api');
  const result = await designRequest('/design/jobs', { key: 'test-key' });
  assert.strictEqual(result.error, 'insufficient credits');
});
