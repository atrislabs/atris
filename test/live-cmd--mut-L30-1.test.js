const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLiveOptions } = require('../commands/live');

test('a leading root flag preserves the chosen workspace folder', () => {
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-root-option-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  try {
    process.env.HOME = room;
    process.chdir(room);
    const root = path.join(room, 'portfolio');
    fs.mkdirSync(root);
    const options = parseLiveOptions(['--root', root], room);
    assert.equal(options.root, root);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
