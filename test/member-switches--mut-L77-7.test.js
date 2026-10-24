'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setMemberAwake, setMemberLoopAwake, getMemberSwitch } = require('../lib/member-switches');

test('setting a loop repairs a saved null loop collection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loop-repair-'));
  try {
    setMemberAwake('maze', true, root);
    const file = path.join(root, '.atris', 'state', 'member-switches.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.members.maze.loops = null;
    fs.writeFileSync(file, JSON.stringify(state));

    setMemberLoopAwake('maze', 'feedback', false, root);

    assert.strictEqual(getMemberSwitch('maze', root).loops.feedback, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
