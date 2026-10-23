'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dreamCommand } = require('../commands/dream');

test('dream accepts a card title with exactly five words', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-five-word-title-'));
  try {
    const logs = path.join(root, 'atris', 'logs', '2040');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, '2040-01-01.md'), 'An open wish needs a next step.\n');

    const cards = [
      {
        title: 'Give each wish one owner',
        why: 'The wish needs someone to help.',
        move: 'Choose a person for the open wish.',
      },
      {
        title: 'Review open wishes',
        why: 'A wish needs a clear next step.',
        move: 'Read the open wish.',
      },
    ];
    const stamp = '2040-01-02T00:00:00.000Z';
    const output = [];
    const code = await dreamCommand(['--yes'], root, {
      now: new Date(stamp),
      stamp,
      runner: async () => ({ ok: true, stdout: JSON.stringify(cards) }),
      log: (line) => output.push(line),
    });

    assert.equal(code, 0);
    assert.deepEqual(output, ['Dreamed 2 cards.', 'Run me nightly: atris dream']);
    const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'dreams.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows, cards.map((card) => ({ ts: stamp, ...card, source: 'dream' })));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
