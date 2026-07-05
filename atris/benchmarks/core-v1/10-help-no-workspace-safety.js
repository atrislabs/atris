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
    assert.equal(tasks.status, 0, tasks.stderr || tasks.stdout);
    const payload = JSON.parse(tasks.stdout);
    assert.equal(payload.schema, 'atris.bench.tasks.v1');
    assert.ok(payload.tasks.some((task) => task.id === 'help-no-workspace-safety'));

    assert.equal(fs.existsSync(path.join(ctx.workspace, 'atris')), false);
    assert.equal(fs.existsSync(path.join(ctx.workspace, '.atris')), false);
  },
};
