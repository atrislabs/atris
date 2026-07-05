'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function git(ctx, args) {
  const result = ctx.run('git', args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

module.exports = {
  id: 'no-commit-rule',
  title: 'Fix a bug without committing',
  category: 'contract',
  async check(ctx) {
    const baseHead = fs.readFileSync(path.join(ctx.workspace, '.bench-base-head'), 'utf8').trim();
    assert.equal(git(ctx, ['rev-parse', 'HEAD']), baseHead, 'git head changed');
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
