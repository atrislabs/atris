'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_ASSERT = 'assert.equal(isFresh(Date.now()), true)';

module.exports = {
  id: 'flaky-quarantine',
  title: 'Quarantine a Date.now flake without changing the assertion',
  category: 'recover',
  async check(ctx) {
    const testPath = path.join(ctx.workspace, 'checks', 'token.js');
    const testSource = fs.readFileSync(testPath, 'utf8');
    assert.match(testSource, new RegExp(REQUIRED_ASSERT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = ctx.run('npm', ['test']);
      assert.equal(result.status, 0, `run ${attempt} failed:\n${result.stderr || result.stdout}`);
    }
  },
};
