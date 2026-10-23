'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { snapshotBeforeInit, commitInitFiles } = require('../lib/init-commit');

test('a hook rejection preserves the configured author error without retrying as another author', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-author-rejection-'));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_AUTHOR_DATE: '2024-01-15T12:00:00Z',
    GIT_COMMITTER_DATE: '2024-01-15T12:00:00Z',
  });
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL,
    '[user]\n name = Example Author\n email = author@example.com\n');
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  const snapshot = snapshotBeforeInit(root);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# instructions\n');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\nprintf "author rejected: " >&2\ngit var GIT_AUTHOR_IDENT >&2\nexit 1\n',
    { mode: 0o755 });

  const result = commitInitFiles(snapshot);
  assert.match(result.detail, /author@example\.com/);
});
