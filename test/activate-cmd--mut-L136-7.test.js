'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('boot reports the number of pending inbox items', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-inbox-count-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const lines = [];
  process.env.HOME = root;
  process.chdir(root);
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'PERSONA.md'), '# persona\n');
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n');
    const state = require('../lib/state-detection');
    const loadContext = state.loadContext;
    t.mock.method(state, 'loadContext', (...args) => ({
      ...loadContext(...args),
      hasInbox: true,
      inboxCount: 2,
      inboxItems: ['review proposal', 'schedule demo'],
    }));
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const { activateAtris } = require('../commands/activate');
    activateAtris();
    assert.match(lines.join('\n'), /\btwo inbox items\b/);
  } finally {
    t.mock.restoreAll();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
