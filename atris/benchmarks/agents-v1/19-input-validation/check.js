'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'input-validation',
  title: 'Reject invalid CLI input with exit code 2',
  category: 'build',
  async check(ctx) {
    const cli = path.join(ctx.workspace, 'divide.js');
    const ok = ctx.run(process.execPath, [cli, '10', '2']);
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    assert.equal(ok.stdout.trim(), '5');

    const bad = ctx.run(process.execPath, [cli, '10', '0']);
    assert.equal(bad.status, 2, bad.stdout || bad.stderr);
    assert.equal(bad.stderr.trim(), 'divisor must be non-zero');
    assert.equal(bad.stdout.trim(), '');
  },
};
