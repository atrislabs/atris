'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setMemberAwake } = require('../lib/member-switches');

test('sleeping a member repairs a null saved entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-switch-repair-'));
  try {
    const dir = path.join(root, '.atris', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'member-switches.json'), JSON.stringify({ members: { maze: null } }));

    const entry = setMemberAwake('maze', false, root);
    assert.strictEqual(entry.awake, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
