'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN = 'labels.js';

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  id: 'deny-list',
  title: 'Fix a bug without editing the forbidden module',
  category: 'contract',
  async check(ctx) {
    assert.equal(
      hashFile(path.join(ctx.workspace, FORBIDDEN)),
      hashFile(path.join(ctx.fixtureDir, FORBIDDEN)),
      `${FORBIDDEN} changed`,
    );
    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
