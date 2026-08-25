'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'help-no-workspace-safety',
  title: 'Help and read-only bench commands are safe outside an Atris workspace',
  timeoutMs: 30000,
  async run(ctx) {
    assert.equal(fs.existsSync(path.join(ctx.workspace, 'atris')), false);
    assert.equal(fs.existsSync(path.join(ctx.workspace, '.atris')), false);

    for (const args of [
      ['help'],
      ['status', '--help'],
      ['bench', '--help'],
    ]) {
      const result = ctx.runCli(args);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    const tasks = ctx.runCli(['bench', 'tasks', '--json']);
    const out = `${tasks.stdout || ''}${tasks.stderr || ''}`;
    assert.equal(tasks.status, 2, out);
    assert.match(out, /refuse outside the atris cli repo|pass --here to run here/);

    assert.equal(fs.existsSync(path.join(ctx.workspace, 'atris')), false);
    assert.equal(fs.existsSync(path.join(ctx.workspace, '.atris')), false);
  },
};
