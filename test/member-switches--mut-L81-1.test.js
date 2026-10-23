'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setMemberAwake, setMemberLoopAwake, isMemberAwake } = require('../lib/member-switches');

test('changing a loop defaults a missing member awake flag to true', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleeping-loop-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    setMemberAwake('maze', true, root);
    const savedFile = path.join(stateDir, fs.readdirSync(stateDir)[0]);
    const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
    delete saved.members.maze.awake;
    fs.writeFileSync(savedFile, JSON.stringify(saved));
    setMemberLoopAwake('maze', 'feedback', true, root);
    assert.strictEqual(isMemberAwake('maze', root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
