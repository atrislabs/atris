'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dreamCommand } = require('../commands/dream');

test('an unsuccessful model exit reports no answer rather than a startup failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dream-exit-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  try {
    const logs = path.join(root, 'atris', 'logs', '2099');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, '2099-01-01.md'), '# Notes\n\n- shipped a loop\n');
    const lines = [];
    await dreamCommand(['--yes'], root, {
      stamp: '2099-01-02T00:00:00.000Z',
      runner: async () => ({ ok: false, status: 1, stdout: '', stderr: '' }),
      log: (line) => lines.push(String(line)),
    });
    assert.match(lines.join('\n'), /no dreams tonight:.*answer/i);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
