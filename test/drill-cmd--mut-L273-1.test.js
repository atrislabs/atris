'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

test('the final ledger check reports a leftover unmerged branch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-leftover-'));
  const oldEnv = { ...process.env };
  const oldCwd = process.cwd();
  const originalSpawn = childProcess.spawnSync;
  const settings = new Map();
  // Keep configuration in memory; commit identity comes from the environment.
  childProcess.spawnSync = function (command, args, options) {
    if (command === 'git' && args[0] === 'config') {
      if (args[1] === '--get') {
        const value = settings.get(args[2]);
        return { status: value === undefined ? 1 : 0, stdout: value || '', stderr: '' };
      }
      settings.set(args[1], args[2]);
      return { status: 0, stdout: '', stderr: '' };
    }
    return originalSpawn.call(this, command, args, options);
  };
  Object.assign(process.env, {
    HOME: home,
    TMPDIR: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'absent-config'),
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  });
  process.chdir(home);
  try {
    const { runDrill } = require('../commands/drill');
    const git = (args, cwd) => {
      const result = originalSpawn('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    let injected = false;
    const result = await runDrill({
      reporter: () => {},
      afterStage(name, ctx) {
        if (name !== 'landing shipped (local mode)') return;
        const tree = git(['rev-parse', 'master^{tree}'], ctx.sandboxPath);
        const commit = git(['commit-tree', tree, '-p', 'master', '-m', 'unfinished work'], ctx.sandboxPath);
        git(['branch', 'unfinished-work', commit], ctx.sandboxPath);
        injected = true;
      },
    });
    assert.equal(injected, true, JSON.stringify(result.stages));
    const ledger = result.stages.find(stage => stage.name === 'ledger checked');
    assert.ok(ledger, 'the final ledger check ran');
    assert.match(ledger.error || '', /unmerged local branches remain:.*\bunfinished-work\b/);
    assert.equal(ledger.ok, false);
    assert.equal(result.pass, false);
  } finally {
    childProcess.spawnSync = originalSpawn;
    process.chdir(oldCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in oldEnv)) delete process.env[key];
    }
    Object.assign(process.env, oldEnv);
  }
});
