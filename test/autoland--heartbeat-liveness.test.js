'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { heartbeatLiveness } = require('../lib/autoland');

// Liveness asks the scheduler. A saved flag in the policy file is ignored:
// it said "installed" for jobs someone had deleted. Every runner here is a
// fake; the real crontab and launchctl are never asked.
function runner(table) {
  return (cmd) => {
    if (cmd !== 'crontab') throw new Error(`unexpected ${cmd}`);
    if (table === null) return { status: 1, stdout: '', stderr: 'crontab: permission denied' };
    return { status: 0, stdout: table, stderr: '' };
  };
}

const root = '/tmp/some-project';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-liveness-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const on = (platform, table) => ({ platform, homeDir: home, uid: 501, spawn: runner(table) });

test('heartbeatLiveness reports a live crontab line as installed and its absence as not installed', () => {
  assert.strictEqual(heartbeatLiveness(root, on('linux', '14 * * * * tick # ATRIS_AUTOLAND_SOME_PROJECT\n')), true);
  assert.strictEqual(heartbeatLiveness(root, on('linux', '0 5 * * * other\n')), false);
  assert.strictEqual(heartbeatLiveness(root, on('darwin', '0 5 * * * other\n')), false);
});

test('heartbeatLiveness returns unknown when the crontab cannot be read', () => {
  assert.strictEqual(heartbeatLiveness(root, on('linux', null)), null);
  assert.strictEqual(heartbeatLiveness(root, on('darwin', null)), null);
});

test('heartbeatLiveness does not count commented or look-alike lines', () => {
  assert.strictEqual(heartbeatLiveness(root, on('linux', '# 14 * * * * tick # ATRIS_AUTOLAND_SOME_PROJECT\n')), false);
  assert.strictEqual(heartbeatLiveness(root, on('linux', '14 * * * * tick # ATRIS_AUTOLAND_SOME_PROJECT_TWO\n')), false);
});
