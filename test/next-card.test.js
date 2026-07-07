'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nextMoves = require('../lib/next-moves');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-next-card-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
}

function appendJsonl(root, relative, rows) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function writeRoadmap(root, title) {
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), `# Roadmap\n\n## Open loop items\n\n- [ ] ${title}\n`, 'utf8');
}

function writeTaskProjection(root, tasks) {
  const file = path.join(root, '.atris', 'state', 'tasks.projection.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tasks }), 'utf8');
}

function writeLatestInbox(root, title) {
  const dir = path.join(root, 'atris', 'logs', '2099');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2099-01-01.md'), `# Log 2099-01-01\n\n## Inbox\n\n- **I1:** ${title}\n`, 'utf8');
}

test('next cards rank waiting wishes, ready missions, old moves, and shipped wish reviews', () => {
  const root = tmp();
  try {
    writeRoadmap(root, 'roadmap move');
    writeTaskProjection(root, [
      { id: 'task-1', display_id: 'CLI-1', title: 'task move', status: 'claimed', claimed_by: 'codex' },
    ]);
    writeLatestInbox(root, 'inbox move');
    appendJsonl(root, '.atris/state/wishes.jsonl', [
      { id: 'wish-7', n: 7, ts: '2099-01-01T00:00:00.000Z', text: 'haiku loop', status: 'needs_input', questions: ['Which kind of haiku loop?'] },
      { id: 'wish-8', n: 8, ts: '2099-01-01T00:01:00.000Z', text: 'shipped wish', status: 'complete' },
    ]);
    appendJsonl(root, '.atris/state/missions.jsonl', [
      { id: 'mission-4', n: 4, objective: 'ready mission', status: 'ready', receipt_path: 'atris/runs/mission-4.json' },
      { id: 'mission-5', n: 5, objective: 'verified mission', status: 'running', verifier_result: { passed: true }, receipt_path: 'atris/runs/mission-5.json' },
    ]);

    const cards = nextMoves.nextCards(root, 10);
    assert.deepEqual(cards.map((card) => card.kind || card.source), [
      'wish_waiting',
      'mission_ready',
      'mission_ready',
      'roadmap',
      'task',
      'inbox',
      'wish_review',
    ]);
    assert.equal(cards[0].label, '#7 haiku loop');
    assert.equal(cards[0].status, 'waiting on you');
    assert.equal(cards.at(-1).label, '#8 shipped wish');
  } finally {
    cleanup(root);
  }
});

test('atris next yes prints the exact wish answer prompt', () => {
  const root = tmp();
  try {
    appendJsonl(root, '.atris/state/wishes.jsonl', [
      { id: 'wish-7', n: 7, ts: '2099-01-01T00:00:00.000Z', text: 'haiku loop', status: 'needs_input', questions: ['Which kind of haiku loop?'] },
    ]);

    const res = runCli(['next', 'yes'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), [
      'Got it, wish #7: haiku loop.',
      'Which kind of haiku loop?',
      'Answer with: atris wish answer "your words"',
    ].join('\n'));
  } finally {
    cleanup(root);
  }
});

test('atris next no parks the current card', () => {
  const root = tmp();
  try {
    appendJsonl(root, '.atris/state/wishes.jsonl', [
      { id: 'wish-1', n: 1, ts: '2099-01-01T00:00:00.000Z', text: 'park me', status: 'needs_input', questions: ['What should change?'] },
    ]);

    const res = runCli(['next', 'no'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Parked #1 park me\./);
    const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'next_parked.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(rows[0].label, '#1 park me');

    const again = runCli(['next'], root);
    assert.equal(again.stdout.trim(), 'Nothing to do. Rest or wish.');
  } finally {
    cleanup(root);
  }
});

test('atris next skip deals the following card without parking', () => {
  const root = tmp();
  try {
    appendJsonl(root, '.atris/state/wishes.jsonl', [
      { id: 'wish-1', n: 1, ts: '2099-01-01T00:00:00.000Z', text: 'first wish', status: 'needs_input', questions: ['What should change?'] },
    ]);
    appendJsonl(root, '.atris/state/missions.jsonl', [
      { id: 'mission-2', n: 2, objective: 'second mission', status: 'ready', receipt_path: 'atris/runs/mission-2.json' },
    ]);

    const res = runCli(['next', 'skip'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^#2 second mission\nWhy now: proof passed and needs your review\nDo it\? yes \/ no \/ skip\n$/);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'next_parked.jsonl')), false);
  } finally {
    cleanup(root);
  }
});

test('atris next empty state is plain', () => {
  const root = tmp();
  try {
    const res = runCli(['next'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'Nothing to do. Rest or wish.');
  } finally {
    cleanup(root);
  }
});
