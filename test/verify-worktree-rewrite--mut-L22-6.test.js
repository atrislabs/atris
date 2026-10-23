'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rewriteWorktreeVerify } = require('../lib/verify-worktree-rewrite');

test('a project outside arena rewrites checks from its sibling copy folder', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-parent-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'demo-project');
  const copy = path.join(temp, '.agent-worktrees', 'demo-project', 'builder');
  const filesystemRoot = path.parse(root).root;
  const basename = path.basename;

  // The filesystem root is the traversal boundary, not a candidate folder.
  // Fail synchronously if traversal crosses it, rather than hanging the test.
  t.mock.method(path, 'basename', (value, suffix) => {
    if (value === filesystemRoot) {
      throw new Error('ancestor traversal crossed the filesystem root');
    }
    return basename(value, suffix);
  });

  const result = rewriteWorktreeVerify(`cd ${copy} && node scripts/check.js`, root);
  assert.equal(result.command, 'node scripts/check.js');
});
