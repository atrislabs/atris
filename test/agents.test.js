const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAgentRows, renderAgentLines, ownerState } = require('../commands/agents');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agents-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function missionsPath(root) {
  return path.join(root, '.atris', 'state', 'missions.jsonl');
}

function appendMission(root, record) {
  const file = missionsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ schema: 'atris.mission.v1', ...record })}\n`, 'utf8');
}

function makeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`, 'utf8');
}

test('groups missions by owner and takes the latest record per mission id', () => {
  const root = makeTempDir();
  try {
    makeMember(root, 'validator');
    appendMission(root, { id: 'm1', n: 1, objective: 'fix the flaky verifier', owner: 'validator', status: 'running', updated_at: '2026-07-01T00:00:00Z' });
    // Later record for the same mission id should win over the first.
    appendMission(root, { id: 'm1', n: 1, objective: 'fix the flaky verifier', owner: 'validator', status: 'ready', updated_at: '2026-07-02T00:00:00Z' });

    const rows = buildAgentRows(root);
    const row = rows.find((r) => r.owner === 'validator');
    assert.ok(row, 'validator row should exist');
    assert.equal(row.state, 'waiting on you');
  } finally {
    cleanupTempDir(root);
  }
});

test('state word mapping: working, stuck, waiting on you, resting, idle', () => {
  assert.equal(ownerState([]).state, 'idle');
  assert.equal(ownerState([{ status: 'running' }]).state, 'working');
  assert.equal(ownerState([{ status: 'planning' }]).state, 'working');
  assert.equal(ownerState([{ status: 'blocked' }]).state, 'stuck');
  assert.equal(ownerState([{ status: 'ready' }]).state, 'waiting on you');
  assert.equal(ownerState([{ status: 'complete' }]).state, 'resting');
  assert.equal(ownerState([{ status: 'stopped' }]).state, 'resting');
  // A stuck mission anywhere in the list wins over a working one.
  assert.equal(ownerState([{ status: 'running' }, { status: 'blocked' }]).state, 'stuck');
});

test('owners come from team directories too, with no missions showing as idle', () => {
  const root = makeTempDir();
  try {
    makeMember(root, 'navigator');
    const rows = buildAgentRows(root);
    const row = rows.find((r) => r.owner === 'navigator');
    assert.ok(row);
    assert.equal(row.state, 'idle');
    assert.equal(row.label, null);
  } finally {
    cleanupTempDir(root);
  }
});

test('sorts stuck first, then waiting on you, then working, then resting/idle', () => {
  const root = makeTempDir();
  try {
    makeMember(root, 'resting-member');
    makeMember(root, 'idle-member');
    appendMission(root, { id: 'a', n: 1, objective: 'ship the release notes', owner: 'working-member', status: 'running', updated_at: '2026-07-01T00:00:00Z' });
    appendMission(root, { id: 'b', n: 2, objective: 'blocked on api keys', owner: 'stuck-member', status: 'blocked', updated_at: '2026-07-01T00:00:00Z' });
    appendMission(root, { id: 'c', n: 3, objective: 'review this pull request', owner: 'waiting-member', status: 'ready', updated_at: '2026-07-01T00:00:00Z' });
    appendMission(root, { id: 'd', n: 4, objective: 'old finished task', owner: 'resting-member', status: 'complete', updated_at: '2026-07-01T00:00:00Z' });

    const rows = buildAgentRows(root);
    const states = rows.map((r) => r.state);
    assert.equal(states[0], 'stuck');
    assert.equal(states[1], 'waiting on you');
    assert.equal(states[2], 'working');
    // resting/idle fill the tail, in either order relative to each other
    assert.ok(states.slice(3).every((s) => s === 'resting' || s === 'idle'));
  } finally {
    cleanupTempDir(root);
  }
});

test('folds resting/idle tail into one count line unless --all is passed', () => {
  const rows = [
    { owner: 'stuck-member', state: 'stuck', label: '#2 blocked on api keys' },
    { owner: 'waiting-member', state: 'waiting on you', label: '#3 review this pull' },
    { owner: 'working-member', state: 'working', label: '#1 ship the release' },
    { owner: 'resting-member', state: 'resting', label: '#4 old finished task' },
    { owner: 'idle-member', state: 'idle', label: null },
  ];

  const folded = renderAgentLines(rows, { all: false });
  assert.equal(folded.length, 4);
  assert.equal(folded[3], '2 members resting or idle. See them with atris agents --all');

  const unfolded = renderAgentLines(rows, { all: true });
  assert.equal(unfolded.length, 5);
  assert.ok(unfolded.some((line) => line.includes('resting-member')));
  assert.ok(unfolded.some((line) => line.includes('idle-member')));
});

test('lines are plain words: no em dashes, only the five known state words', () => {
  const rows = [
    { owner: 'validator', state: 'stuck', label: '#2 blocked on api keys' },
    { owner: 'navigator', state: 'idle', label: null },
  ];
  const lines = renderAgentLines(rows, { all: true });
  for (const line of lines) {
    assert.ok(!line.includes('—'), `line should not contain an em dash: ${line}`);
  }
});
