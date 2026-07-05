'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'null-guard',
  title: 'Guard a crash on heading-less input',
  category: 'edit',
  async check(ctx) {
    const testResult = ctx.run('npm', ['test']);
    assert.equal(testResult.status, 0, testResult.stderr || testResult.stdout);

    const emptyRun = ctx.run(process.execPath, ['cli.js', 'empty.md']);
    assert.equal(emptyRun.status, 0, emptyRun.stderr || emptyRun.stdout);
    const emptyOut = JSON.parse(emptyRun.stdout);
    assert.deepEqual(emptyOut, { headings: [], lastLevel: null });

    const normalRun = ctx.run(process.execPath, ['cli.js', 'sample.md']);
    assert.equal(normalRun.status, 0, normalRun.stderr || normalRun.stdout);
    const normalOut = JSON.parse(normalRun.stdout);
    assert.deepEqual(normalOut, { headings: ['# Title', '## Sub'], lastLevel: 2 });
  },
};
