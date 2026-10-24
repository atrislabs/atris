'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('zen reports completed workspace cleanup and the action left for its owner', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-workspace-output-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit: ${code}`); });
  const apply = require('../lib/zen-apply');
  t.mock.method(apply, 'applyZen', () => ({
    ok: true,
    zen: true,
    root: home,
    upstream: null,
    already: false,
    workspace: {
      ran: true,
      done: ['fixed 1 broken map link'],
      todo: [],
      yours: [{ text: '1 file looks unused', cmd: 'atris clean --dry-run' }],
    },
    done: [],
    left: [],
    notes: [],
    saved: [],
    team_files: 0,
    remaining: [],
  }));
  try {
    const { zenCommand } = require('../commands/zen');
    zenCommand(['--no-fetch'], home);
    const output = lines.join('\n');
    assert.match(output, /fixed 1 broken map link/);
    assert.match(output, /1 file looks unused/);
    assert.match(output, /atris clean --dry-run/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
