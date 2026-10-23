'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteWorktreeVerify } = require('../lib/verify-worktree-rewrite');

test('a check without a workspace keeps its command', () => {
  const command = 'node scripts/check.js';
  const result = rewriteWorktreeVerify(command);
  assert.equal(result.command, command);
});
