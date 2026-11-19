'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildMemberRunStartArgs } = require('../commands/member');

// Seen live 2026-11-17: a member whose shared mission says "no merges" was woken in a private copy.
test('a member whose standing mission forbids merges runs in the shared folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-standing-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const dir = path.join(root, 'atris', 'team', 'krishna');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: krishna\n---\n');
    fs.writeFileSync(path.join(dir, 'MISSION.md'), 'The shared mission is in atris/MISSION.md.\n');
    fs.writeFileSync(path.join(root, 'atris', 'MISSION.md'), '# The hour\n\nWrite your own folder. No sends, no spending, no merges.\n');
    assert.ok(!buildMemberRunStartArgs('krishna', 'Think about the town.', [], root).includes('--worktree'));
    fs.writeFileSync(path.join(root, 'atris', 'MISSION.md'), '# The hour\n\nShip the fix.\n');
    assert.ok(buildMemberRunStartArgs('krishna', 'Think about the town.', [], root).includes('--worktree'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
