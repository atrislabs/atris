'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'syntax-triage',
  title: 'Repair three syntax errors across a small VM',
  category: 'recover',
  async check(ctx) {
    for (const file of ['stack.js', 'ops.js', 'vm.js']) {
      const result = ctx.run(process.execPath, ['--check', path.join(ctx.workspace, file)]);
      assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
    }
    const testResult = ctx.run('npm', ['test']);
    assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout);
  },
};
