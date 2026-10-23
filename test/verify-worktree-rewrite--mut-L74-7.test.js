'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rewriteWorktreeVerify } = require('../lib/verify-worktree-rewrite');

test('a check spanning two projects preserves both original copy paths', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-project-check-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'arena', 'demo-project');
  fs.mkdirSync(root, { recursive: true });
  const copy = path.join(temp, 'arena', '.agent-worktrees', 'demo-project', 'builder');
  const command = `node ${copy}/scripts/check.js && node .agent-worktrees/other-project/builder/scripts/check.js`;
  const result = rewriteWorktreeVerify(command, root);
  assert.equal(result.command, command);
});
