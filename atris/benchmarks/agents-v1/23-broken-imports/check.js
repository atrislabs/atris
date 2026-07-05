'use strict';

const assert = require('node:assert/strict');

module.exports = {
  id: 'broken-imports',
  title: 'Repair broken and circular import paths in a CSV splitter',
  category: 'recover',
  async check(ctx) {
    const testResult = ctx.run('npm', ['test']);
    assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout);

    const runResult = ctx.run(process.execPath, ['index.js', 'data.csv']);
    assert.equal(runResult.status, 0, runResult.stderr || runResult.stdout);
    assert.deepEqual(JSON.parse(runResult.stdout), ['A1,3\nB2,1', 'C3,5\nD4,2']);
  },
};
