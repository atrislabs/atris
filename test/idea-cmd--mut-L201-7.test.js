'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('retry keeps a landed idea out of the waiting queue', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-retry-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  process.env.HOME = home;
  process.chdir(home);
  process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
  try {
    const { ideaAtris } = require('../commands/idea');
    const { addIdea, updateIdea, readIdeas } = require('../lib/idea-inbox');
    const now = new Date('2025-01-15T12:00:00Z');
    const idea = addIdea(home, 'shorten the help text', { now });
    updateIdea(home, idea.id, { status: 'landed' }, { now });

    ideaAtris(['retry', '1'], { cwd: home, log: () => {} });

    assert.strictEqual(readIdeas(home)[0].status, 'landed');
  } finally {
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
