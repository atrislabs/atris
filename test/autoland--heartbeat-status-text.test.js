'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autoland-heartbeat-'));
process.env.HOME = tmpDir;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) {
    delete process.env[key];
  }
}

test.after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

const { heartbeatStatusText } = require('../lib/autoland');

test('heartbeatStatusText reports installed and uninstalled states when no ticks exist', () => {
  const ws = path.join(tmpDir, 'ws-normal');
  fs.mkdirSync(ws, { recursive: true });

  const uninstalled = heartbeatStatusText(ws, { heartbeat_installed: false });
  assert.strictEqual(uninstalled, 'not installed - run atris autoland on');

  const installed = heartbeatStatusText(ws, { heartbeat_installed: true });
  assert.strictEqual(installed, 'installed, but no tick has ever run - run atris autoland tick');
});

test('heartbeatStatusText reports unknown status for missing or non-boolean policy shapes', () => {
  const ws = path.join(tmpDir, 'ws-edge');
  fs.mkdirSync(ws, { recursive: true });

  assert.strictEqual(heartbeatStatusText(ws, {}), 'unknown - run atris autoland on to check and repair');
  assert.strictEqual(heartbeatStatusText(ws, null), 'unknown - run atris autoland on to check and repair');
  assert.strictEqual(heartbeatStatusText(ws, undefined), 'unknown - run atris autoland on to check and repair');
  assert.strictEqual(heartbeatStatusText(ws, { heartbeat_installed: 'true' }), 'unknown - run atris autoland on to check and repair');
  assert.strictEqual(heartbeatStatusText(ws, { heartbeat_installed: 1 }), 'unknown - run atris autoland on to check and repair');
  assert.strictEqual(heartbeatStatusText(ws, { heartbeat_installed: null }), 'unknown - run atris autoland on to check and repair');
});

test('heartbeatStatusText ignores unrelated files in runs directory and handles non-existent paths', () => {
  const ws = path.join(tmpDir, 'ws-runs');
  const runsDir = path.join(ws, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });

  fs.writeFileSync(path.join(runsDir, 'not-a-tick.json'), '{}');
  fs.writeFileSync(path.join(runsDir, 'autoland-tick-1.txt'), '{}');
  fs.writeFileSync(path.join(runsDir, 'autoland-tick'), '{}');

  const withIgnoredFiles = heartbeatStatusText(ws, { heartbeat_installed: true });
  assert.strictEqual(withIgnoredFiles, 'installed, but no tick has ever run - run atris autoland tick');

  const nonExistent = path.join(tmpDir, 'does-not-exist');
  assert.strictEqual(
    heartbeatStatusText(nonExistent, { heartbeat_installed: false }),
    'not installed - run atris autoland on'
  );
  assert.strictEqual(
    heartbeatStatusText(nonExistent, {}),
    'unknown - run atris autoland on to check and repair'
  );
});
