// Seen 2026-11-17: a member's round read "Mission Tick 61/60", the mission's whole-life count
// over this run's guard, which looks like a run past its limit. Each number now says what it is.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildTickPrompt } = require('../commands/mission');

function heading(t, runRound) {
  const tempRoot = path.join(__dirname, '..', '.test-tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'round-heading-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris', 'team', 'writer'), { recursive: true });
  const prompt = buildTickPrompt({ objective: 'write', owner: 'writer', cadence: 'manual', status: 'running' },
    61, 60, { lane: 'workspace', verifier: '' }, [], root, runRound);
  return prompt.split('\n')[0];
}

test('a run says its own round over its own limit, apart from the whole-life count', (t) => {
  assert.equal(heading(t, 23), '# Mission Tick 61 (round 23 of at most 60 in this run)');
});

test('without a run round the old heading stands', (t) => {
  assert.equal(heading(t, null), '# Mission Tick 61/60');
});
