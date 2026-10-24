'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { trackedSandboxPids } = require('../lib/sandbox-pids');

test('a scan with no matching processes does not report process group zero', async () => {
  // A no-match exit from pgrep or lsof is a successful, empty scan.
  const pids = await trackedSandboxPids(
    { pgid: 4242, leaseFile: '', cwd: '' },
    { scan: async () => ({ ok: true, stdout: '' }) },
  );
  assert.equal(pids.includes(0), false);
});
