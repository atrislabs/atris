'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../lib/site-publish');

test('status 300 response is treated as failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mut-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');

  const code = await run([dir, '--slug', 'slug', '--no-claim'], {
    loadCredentials: () => ({ token: 'tok' }),
    fetch: async () => ({ status: 300, json: async () => ({ verified: true }) }),
    log: () => {},
    error: () => {},
  });

  assert.strictEqual(code, 1);
});
