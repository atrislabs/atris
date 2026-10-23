'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextCommand } = require('../commands/next');

test('a roadmap suggestion displays its title when it has no separate label', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-card-title-'));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const oldLog = console.log;
  const oldExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n\n## Open loop items\n\n- [ ] Repair login form\n');
    await nextCommand(['no'], root, {
      stamp: '2025-01-02T12:00:00.000Z',
      log: (line) => lines.push(String(line)),
    });
    assert.match(lines.join('\n'), /Repair login/);
  } finally {
    process.chdir(oldCwd);
    console.log = oldLog;
    process.exit = oldExit;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
