'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('recent saved wishes are included in the day notes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-recent-wish-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  try {
    const { dreamCommand } = require('../commands/dream');
    const journal = path.join(root, 'atris', 'logs', '2025');
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(journal, '2025-01-01.md'), '# Notes\n\nReview the current work.\n');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'wishes.jsonl'), JSON.stringify({
      ts: '2025-01-01T12:00:00.000Z',
      kind: 'wish',
      text: 'Bring the garden notebook to the planning meeting',
    }) + '\n');

    let prompt = '';
    await dreamCommand(['--yes'], root, {
      now: new Date('2025-01-02T00:00:00.000Z'),
      stamp: '2025-01-02T00:00:00.000Z',
      log: () => {},
      runner: async (call) => {
        prompt = call.prompt;
        return { ok: true, stdout: JSON.stringify([
          { title: 'Review the garden plan', why: 'Prepare for the meeting', move: 'Open the garden notebook' },
          { title: 'Review the current work', why: 'Find the next step', move: 'Read the current notes' },
        ]) };
      },
    });

    assert.equal(prompt.includes('garden notebook to the planning meeting'), true);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
