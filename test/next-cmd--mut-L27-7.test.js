'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextCommand } = require('../commands/next');

test('skipping a roadmap item preserves the following suggestion title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roadmap-title-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n\n## Open loop items\n\n- [ ] Repair menu navigation\n- [ ] Repair invoice delivery\n');
    nextCommand(['skip'], root, { log: (line) => lines.push(String(line)) });
    assert.match(lines.join('\n'), /invoice/i);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
