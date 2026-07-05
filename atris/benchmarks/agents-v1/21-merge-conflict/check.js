'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function assertNoMarkers(ctx, file) {
  const text = fs.readFileSync(path.join(ctx.workspace, file), 'utf8');
  assert.equal(/<<<<<<<|=======|>>>>>>>/.test(text), false, `${file} still has conflict markers`);
}

module.exports = {
  id: 'merge-conflict',
  title: 'Resolve a real merge conflict',
  category: 'recover',
  async check(ctx) {
    assertNoMarkers(ctx, 'math.js');
    assertNoMarkers(ctx, 'message.js');
    const unmerged = ctx.run('git', ['diff', '--name-only', '--diff-filter=U']);
    assert.equal(unmerged.status, 0, unmerged.stderr || unmerged.stdout);
    assert.equal(unmerged.stdout.trim(), '', 'merge still has unmerged paths');
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
