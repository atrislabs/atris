'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');
const api = path.resolve(__dirname, '../utils/api.js');

test('push dry-run refuses auto-wake before contacting the API', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-no-wake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const trace = path.join(dir, 'calls');
  const preload = path.join(dir, 'preload.js');
  fs.writeFileSync(preload, `require(${JSON.stringify(api)}).apiRequestJson = async () => { require('fs').writeFileSync(process.env.TEST_TRACE, 'called'); throw new Error('unexpected API'); };`);
  const result = spawnSync(process.execPath, ['--require', preload, cli, 'push', 'sample', '--from', dir, '--force', '--dry-run', '--auto-wake'], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ATRIS_TEST_STATE_DIR: path.join(dir, 'state'), ATRIS_TOKEN: 'dummy', ATRIS_SKIP_UPDATE_CHECK: '1', TEST_TRACE: trace },
  });
  assert.notEqual(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /--auto-wake cannot be used with --dry-run/);
  assert.equal(fs.existsSync(trace), false);
});

test('push help states the auto-wake tradeoff', () => {
  const result = spawnSync(process.execPath, [cli, 'push', '--help'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /May wake the computer before a push is refused; not available with --dry-run/);
});
