const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installPack } = require('../commands/pack');

test('registry error takes precedence over message for purchase instructions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-purchase-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(line));
  const deps = {
    getAppBaseUrl: () => 'https://app.test/',
    loadCredentials: () => null,
    httpRequest: async () => ({
      status: 400,
      body: Buffer.from(JSON.stringify({
        error: 'Purchase required.',
        message: 'Access unavailable.',
      })),
    }),
  };

  assert.equal(await installPack(['sample-pack', '--dir', path.join(dir, 'installed')], dir, { deps }), 1);
  assert.deepEqual(errors, [
    'this pack is paid: sample-pack.',
    'buy it on its page, then run this again.',
    'https://app.test/packs/sample-pack',
    'already bought it? run atris login',
  ]);
});
