'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextCommand } = require('../commands/next');

test('skipping an open task tells the operator to do the following task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-task-'));
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { id: 'first', title: 'Fix the menu', status: 'open' },
        { id: 'second', title: 'Fix the search', status: 'open' },
      ],
    }));

    const lines = [];
    const code = nextCommand(['skip'], root, { log: (line) => lines.push(line) });

    assert.equal(code, 0);
    assert.deepEqual(lines, ['', 'Fix the search is waiting.\n\nnext: atris do']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
