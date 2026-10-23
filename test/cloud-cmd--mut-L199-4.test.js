'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cloudClean } = require('../commands/cloud');

test('cloudClean does not delay before deleting the first orphan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cloud-mut-'));
  const origSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, delay, ...args) => {
    if (delay === 600) {
      delays.push(delay);
      return origSetTimeout(fn, 0, ...args);
    }
    return origSetTimeout(fn, delay, ...args);
  };

  try {
    const deps = {
      loadCredentials: () => ({ token: 'test-token' }),
      apiRequestJson: async (pathname) => {
        if (pathname === '/business/') {
          return { ok: true, status: 200, data: [{ id: 'biz-1', workspace_id: 'ws-1', slug: 'example-co' }] };
        }
        if (pathname.includes('/snapshot')) {
          return { ok: true, status: 200, data: { files: [{ path: '/orphan.txt' }] } };
        }
        return { ok: true, status: 200, data: {} };
      },
      loadBusinesses: () => ({}),
      saveBusinesses: () => {},
      computeLocalHashes: () => ({}),
      isMassDeletePlan: () => false,
    };

    const result = await cloudClean(['clean', 'example-co', '--yes'], dir, deps);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(delays, []);
  } finally {
    global.setTimeout = origSetTimeout;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
