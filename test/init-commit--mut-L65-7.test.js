'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshotBeforeInit, commitInitFiles } = require('../lib/init-commit');

test('staging blocked by an existing index lock preserves the git diagnostic', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-staging-lock-'));
  const keys = ['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = keys.map((key) => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = root;
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'unused-config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr || 'git init failed');
  const snapshot = snapshotBeforeInit(root);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# project instructions\n');
  fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');

  const result = commitInitFiles(snapshot);
  assert.match(result.detail, /index\.lock/);
});
