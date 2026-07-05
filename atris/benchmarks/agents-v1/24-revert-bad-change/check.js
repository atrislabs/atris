'use strict';

const assert = require('node:assert/strict');

module.exports = {
  id: 'revert-bad-change',
  title: 'Recover from a bad HEAD commit',
  category: 'recover',
  async check(ctx) {
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
