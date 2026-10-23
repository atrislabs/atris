'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextCommand } = require('../commands/next');

test('a flag before no still parks the suggested roadmap item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-flag-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n\n## Open loop items\n\n- [ ] Repair login form\n');
    await nextCommand(['--verbose', 'no'], root, {
      stamp: '2025-01-02T12:00:00.000Z',
      log: (line) => lines.push(String(line)),
    });
    const parkedFile = path.join(root, '.atris', 'state', 'next_parked.jsonl');
    const parked = fs.existsSync(parkedFile)
      ? fs.readFileSync(parkedFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
      : [];
    assert.equal(parked[0]?.source, 'roadmap');
  } finally {
    process.chdir(previousCwd);
    console.log = previousLog;
    process.exit = previousExit;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
