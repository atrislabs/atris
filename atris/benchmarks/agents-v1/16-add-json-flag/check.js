'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'add-json-flag',
  title: 'Add a JSON output flag to a toy CLI',
  category: 'build',
  async check(ctx) {
    const cli = path.join(ctx.workspace, 'cli.js');
    const plain = ctx.run(process.execPath, [cli, 'count', 'words.txt']);
    assert.equal(plain.status, 0, plain.stderr || plain.stdout);
    assert.equal(plain.stdout.trim(), 'words: 4');

    const json = ctx.run(process.execPath, [cli, 'count', 'words.txt', '--json']);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    assert.deepEqual(JSON.parse(json.stdout), { words: 4 });
  },
};
