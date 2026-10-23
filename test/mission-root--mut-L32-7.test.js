'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('git fallback finds the repository root when SQLite is unavailable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-root-fallback-'));
  const repo = path.join(home, 'repo');
  const sub = path.join(repo, 'nested');
  fs.mkdirSync(sub, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key];
  }
  const init = spawnSync('git', ['init', '--quiet', repo], { cwd: home, env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr || 'git initialization failed');
  const result = spawnSync(process.execPath, [
    '--no-experimental-sqlite', '-e',
    "process.stdout.write(require('../lib/mission-root').resolveWorkspaceRoot(process.argv[1]))",
    sub,
  ], { cwd: __dirname, env, encoding: 'utf8' });
  assert.strictEqual(result.stdout, fs.realpathSync(repo));
});
