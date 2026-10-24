'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ideaAtris } = require('../commands/idea');
const { readIdeas } = require('../lib/idea-inbox');

test('an idea captured from a subfolder is saved in the repository inbox', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-root-')));
  const root = path.join(home, 'repo');
  const nested = path.join(root, 'src');
  fs.mkdirSync(nested, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    execFileSync('git', ['init', '-q', root], { env: { ...process.env, HOME: home } });
    ideaAtris(['shorten the help examples'], { cwd: nested, log: () => {} });
    assert.equal(readIdeas(root).length, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
