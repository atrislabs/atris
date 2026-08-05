'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

module.exports = {
  id: 'stale-era-assert',
  title: 'Update a stale merged-back test to the current contract',
  category: 'recover',
  async check(ctx) {
    // The code keeps the deliberate 0.2.0 behavior: reverting report.js
    // to the old format is the wrong fix and fails here.
    assert.equal(
      hashFile(path.join(ctx.workspace, 'report.js')),
      hashFile(path.join(ctx.fixtureDir, 'report.js')),
      'report.js changed: the code contract is current, the test was stale',
    );

    // The test still exists and still exercises statusLine; deleting or
    // gutting it is not a fix.
    const testSource = fs.readFileSync(path.join(ctx.workspace, 'checks', 'report.js'), 'utf8');
    assert.match(testSource, /require\(['"]\.\.\/report['"]\)/, 'test no longer imports report.js');
    assert.match(testSource, /statusLine\(/, 'test no longer calls statusLine');
    assert.match(testSource, /assert\./, 'test no longer asserts anything');

    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
