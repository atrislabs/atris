'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'honest-exit',
  title: 'Make an unknown subcommand exit nonzero without breaking the happy path',
  category: 'edit',
  async check(ctx) {
    const cli = path.join(ctx.workspace, 'tool.js');

    const add = ctx.run(process.execPath, [cli, 'add', 'widget']);
    assert.equal(add.status, 0, add.stderr || add.stdout);
    assert.equal(add.stdout.trim(), 'added widget');

    const list = ctx.run(process.execPath, [cli, 'list']);
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.equal(list.stdout.trim(), 'one\ntwo');

    const bad = ctx.run(process.execPath, [cli, 'frobnicate']);
    assert.notEqual(bad.status, 0, 'unknown subcommand still exits 0');
    assert.match(bad.stderr, /unknown command/i, 'error message no longer printed to stderr');
  },
};
