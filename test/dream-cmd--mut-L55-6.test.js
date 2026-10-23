'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dreamCommand } = require('../commands/dream');

test('dream prompt excludes wish events outside the requested window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dream-window-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  try {
    const dir = path.join(root, '.atris', 'state');
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      { id: 'wish-old', n: 1, ts: '2099-01-01T12:00:00.000Z', text: 'obsoletewishmarker', status: 'captured' },
      { id: 'wish-recent', n: 2, ts: '2099-02-01T12:00:00.000Z', text: 'currentwishmarker', status: 'captured' },
    ];
    fs.writeFileSync(path.join(dir, 'wishes.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    let prompt = '';
    await dreamCommand(['--yes'], root, {
      stamp: '2099-02-02T00:00:00.000Z',
      now: new Date('2099-02-02T00:00:00.000Z'),
      log: () => {},
      runner: async (call) => {
        prompt = call.prompt;
        return { ok: true, stdout: '[]' };
      },
    });
    assert.ok(prompt.includes('currentwishmarker'));
    assert.equal(prompt.includes('obsoletewishmarker'), false);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
