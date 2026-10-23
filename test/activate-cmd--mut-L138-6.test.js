'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activateAtris } = require('../commands/activate');

test('a counted inbox bullet with no words keeps the quiet workspace line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-inbox-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const origLog = console.log;
  const lines = [];
  try {
    process.env.HOME = root;
    const atrisDir = path.join(root, 'atris');
    const now = new Date();
    const year = String(now.getFullYear());
    const stamp = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    fs.mkdirSync(path.join(atrisDir, 'logs', year), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'PERSONA.md'), '# persona\n', 'utf8');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# map\n', 'utf8');
    fs.writeFileSync(
      path.join(atrisDir, 'logs', year, `${stamp}.md`),
      '# log\n\n## Inbox\n\n- ***\n\n## Notes\n',
      'utf8',
    );
    console.log = (...args) => lines.push(args.join(' '));
    process.chdir(root);
    activateAtris();
    const output = lines.join('\n');
    assert.match(output, /right now: the workspace is inbox\./);
    assert.doesNotMatch(output, /inbox item is waiting/);
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
