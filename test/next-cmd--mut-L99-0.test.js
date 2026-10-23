'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { nextCommand } = require('../commands/next');

test('skip speaks the completion command for a mission card with proof', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-skip-mission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'wishes.jsonl'), JSON.stringify({
    id: 'wish-1',
    n: 1,
    ts: '2099-01-01T00:00:00.000Z',
    text: 'first wish',
    status: 'needs_input',
    questions: ['What should change?'],
  }) + '\n', 'utf8');
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), JSON.stringify({
    id: 'mission-2',
    n: 2,
    objective: 'second mission',
    status: 'ready',
    receipt_path: 'atris/runs/mission-2.json',
  }) + '\n', 'utf8');

  const lines = [];
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  process.chdir(root);
  process.env.HOME = root;
  try {
    nextCommand(['skip'], root, { log: (line) => lines.push(String(line)) });
  } finally {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
  }

  assert.match(lines.join('\n'), /^next: atris mission complete mission-2 --proof atris\/runs\/mission-2\.json$/m);
});
