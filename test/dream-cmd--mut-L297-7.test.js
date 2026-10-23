'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dreamCommand } = require('../commands/dream');

test('an unreadable card response records the supplied timestamp', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-journal-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  const log = console.log;
  const exit = process.exit;
  const stamp = '2001-02-03T04:05:06.000Z';
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const journal = path.join(root, 'atris', 'logs', '2099');
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, '2099-01-01.md'), '# Log\n\n- finished a review\n');
    await dreamCommand(['--yes'], root, {
      stamp,
      log: () => {},
      runner: async () => ({ ok: true, stdout: 'not json' }),
    });
    const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'dreams.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.strictEqual(rows.at(-1).ts, stamp);
  } finally {
    process.chdir(cwd);
    console.log = log;
    process.exit = exit;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
