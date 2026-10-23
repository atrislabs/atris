'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { searchCommand } = require('../commands/search');

test('a matching archived journal entry appears in compact search results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-match-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'logs', '2024-01-15.md'),
      '# journal\n\nResolved amberquartz deployment failure.\n');
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    searchCommand(['amberquartz', '--memory-only'], { root });
    assert.match(output.join('\n'), /Resolved amberquartz deployment failure/);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
