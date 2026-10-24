'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveWorkspaceRoot } = require('../lib/mission-root');

test('git fallback finds the repository when the task resolver is unavailable', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-git-fallback-'));
  const savedHome = process.env.HOME;
  const taskDb = require('../lib/task-db');
  const savedResolver = taskDb.workspaceRoot;
  try {
    process.env.HOME = temporary;
    const repo = fs.realpathSync(temporary);
    const child = path.join(repo, 'src');
    fs.mkdirSync(child);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key];
    }
    const initialized = spawnSync('git', ['init', '-q', repo], { env, encoding: 'utf8' });
    if (initialized.error) throw initialized.error;
    if (initialized.status !== 0) throw new Error(initialized.stderr);

    // Exercise recovery from an unavailable task store using real Git output.
    taskDb.workspaceRoot = () => { throw new Error('task store unavailable'); };
    assert.strictEqual(resolveWorkspaceRoot(child), repo);
  } finally {
    taskDb.workspaceRoot = savedResolver;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
