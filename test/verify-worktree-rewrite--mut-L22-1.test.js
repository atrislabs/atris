'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rewriteWorktreeVerify } = require('../lib/verify-worktree-rewrite');

test('rewrites an agent check when the main project is nested below arena', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-project-check-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const arena = path.join(temp, 'arena');
  const root = path.join(arena, 'projects', 'demo-project');
  fs.mkdirSync(root, { recursive: true });
  const copy = path.join(arena, '.agent-worktrees', 'demo-project', 'builder');
  const result = rewriteWorktreeVerify(`cd ${copy} && node scripts/check.js`, root);
  assert.equal(result.command, 'node scripts/check.js');
});
