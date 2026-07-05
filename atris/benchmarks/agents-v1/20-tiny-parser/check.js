'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = {
  id: 'tiny-parser',
  title: 'Parse a tiny key=value format',
  category: 'build',
  async check(ctx) {
    const cases = [
      {
        input: 'host=localhost\nport=8080\n',
        expected: { host: 'localhost', port: '8080' },
      },
      {
        input: '# comment\n\nmode=safe\n# tail\n',
        expected: { mode: 'safe' },
      },
      {
        input: 'note=hello=world\n',
        expected: { note: 'hello=world' },
      },
    ];

    delete require.cache[require.resolve(path.join(ctx.workspace, 'pairs.js'))];
    const { parsePairs } = require(path.join(ctx.workspace, 'pairs.js'));
    for (const [index, sample] of cases.entries()) {
      assert.deepEqual(parsePairs(sample.input), sample.expected, `case ${index + 1} failed`);
    }

    const result = ctx.run('npm', ['test']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  },
};
