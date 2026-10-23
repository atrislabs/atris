'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('approving a mission card without proof asks for review', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-missing-proof-'));
  const home = process.env.HOME;
  const cwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  const moves = require('../lib/next-moves');
  const originalCards = moves.nextCards;
  const lines = [];
  const originalExit = process.exit;
  const exitSignal = new Error('command exited');
  try {
    moves.nextCards = () => [{
      id: 'review-card',
      title: 'Review completed work',
      source: 'mission',
      kind: 'mission_ready',
      next_action: { type: 'mission_complete', mission_id: 'mission-without-proof' },
    }];
    const { nextCommand } = require('../commands/next');
    process.exit = () => { throw exitSignal; };
    try {
      nextCommand(['yes'], root, { log: (line) => lines.push(String(line)) });
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.match(lines.join('\n'), /review/i);
  } finally {
    process.exit = originalExit;
    moves.nextCards = originalCards;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
