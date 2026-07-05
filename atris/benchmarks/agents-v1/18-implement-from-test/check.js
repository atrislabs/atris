'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  id: 'implement-from-test',
  title: 'Implement behavior to satisfy a provided failing test',
  category: 'build',
  async check(ctx) {
    const testPath = path.join('checks', 'leaders.js');
    assert.equal(
      hashFile(path.join(ctx.workspace, testPath)),
      hashFile(path.join(ctx.fixtureDir, testPath)),
      'test file changed',
    );
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
