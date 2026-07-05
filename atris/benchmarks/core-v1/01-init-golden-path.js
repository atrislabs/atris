'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  id: 'init-golden-path',
  title: 'Atris init creates the canonical workspace skeleton',
  timeoutMs: 30000,
  async run(ctx) {
    const result = ctx.runCli(['init'], { input: '\n', timeoutMs: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    for (const rel of [
      'CLAUDE.md',
      path.join('atris', 'atris.md'),
      path.join('atris', 'CLAUDE.md'),
      path.join('atris', 'MAP.md'),
      path.join('atris', 'TODO.md'),
      path.join('atris', 'features'),
      path.join('atris', 'experiments', 'README.md'),
      path.join('atris', 'lessons.md'),
    ]) {
      assert.ok(fs.existsSync(path.join(ctx.workspace, rel)), `${rel} should exist after init`);
    }

    const status = ctx.runCli(['status'], { timeoutMs: 30000 });
    assert.equal(status.status, 0, status.stderr || status.stdout);
  },
};
