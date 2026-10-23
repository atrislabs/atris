'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ideaAtris } = require('../commands/idea');

test('retry with an idea number looks up that idea', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-retry-boundary-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  process.env.HOME = repo;
  process.chdir(repo);
  try {
    const lines = [];
    const code = await ideaAtris(['retry', '1', '--json'], { cwd: repo, log: line => lines.push(line) });
    assert.match(lines.join('\n'), /no idea 1\b/i);
    assert.equal(code, 2);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
