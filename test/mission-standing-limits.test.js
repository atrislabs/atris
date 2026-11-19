'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildTickPrompt } = require('../commands/mission');

function withPrompt(objective, standingMission, sharedMission, check) {
  const tempRoot = path.join(__dirname, '..', '.test-tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'standing-limits-'));
  try {
    const memberDir = path.join(root, 'atris', 'team', 'writer');
    fs.mkdirSync(memberDir, { recursive: true });
    fs.writeFileSync(path.join(memberDir, 'MISSION.md'), standingMission);
    if (sharedMission) fs.writeFileSync(path.join(root, 'atris', 'MISSION.md'), sharedMission);
    const prompt = buildTickPrompt({ objective, owner: 'writer', cadence: 'manual', status: 'running' }, 1, 1, { lane: 'workspace', verifier: '' }, [], root);
    check(prompt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertRestricted(prompt) {
  assert.match(prompt, /leave your work as files, do not commit, push or merge/i);
  assert.match(prompt, /if there is no useful next step, say so and stop/i);
  assert.doesNotMatch(prompt, /## Landing rule|## No claimable work\? Work the backstop ladder|atris\/status\/for-you\.md/);
}

test('objective restrictions suppress the landing rule and backstop', () => {
  for (const objective of ['Write a note, do not commit', 'Write a note, no push', 'Write a note, do not merge']) {
    withPrompt(objective, 'Write useful notes.', '', assertRestricted);
  }
});

test('standing mission restrictions include the linked shared mission', () => {
  withPrompt('Write a note', 'Do not commit.', '', assertRestricted);
  withPrompt('Write a note', 'Follow atris/MISSION.md.', 'No push, no merge. Write only your own folder.', assertRestricted);
});

test('ordinary work retains the ladder and acknowledges standing mission limits', () => {
  withPrompt('Fix a test', 'Keep the project healthy.', '', (prompt) => {
    assert.match(prompt, /## No claimable work\? Work the backstop ladder/);
    assert.match(prompt, /## Landing rule/);
    assert.match(prompt, /standing mission.*limits win/i);
    assert.match(prompt, /atris\/status\/for-you\.md/);
  });
});
