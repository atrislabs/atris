'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'wire-subcommand',
  title: 'Wire a stats subcommand into a toy CLI',
  category: 'build',
  async check(ctx) {
    const cli = path.join(ctx.workspace, 'cli.js');
    const list = ctx.run(process.execPath, [cli, 'list']);
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /apple: 3/);
    assert.match(list.stdout, /banana: 5/);

    const stats = ctx.run(process.execPath, [cli, 'stats']);
    assert.equal(stats.status, 0, stats.stderr || stats.stdout);
    assert.deepEqual(JSON.parse(stats.stdout), { items: 2, quantity: 8 });
  },
};
