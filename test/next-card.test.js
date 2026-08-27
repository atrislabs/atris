'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nextMoves = require('../lib/next-moves');
const { spokenLineCount } = require('../lib/first-minute');
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
  const home = path.join(cwd, '.home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      HOME: home,
      USER: 'ubuntu',
      LOGNAME: 'ubuntu',
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
}

function spoken(stdout) {
  return String(stdout || '').replace(/^\n+/, '').trimEnd();
}

function nextLine(stdout) {
  const match = String(stdout || '').match(/^next: (.+)$/m);
  return match ? match[1] : '';
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

function writeTodayInbox(root, title) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dir = path.join(root, 'atris', 'logs', year);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${year}-${month}-${day}.md`), `# Log ${year}-${month}-${day}\n\n## Inbox\n\n- **I1:** ${title}\n`, 'utf8');
}

function writeReadyRoom(root) {
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n(Empty)\n', 'utf8');
}

test('next cards rank waiting wishes, ready missions, old moves, and shipped wish reviews', () => {
  const root = tmp();
  try {
    writeRoadmap(root, 'roadmap move');
    writeTaskProjection(root, [
      { id: 'task-1', display_id: 'CLI-1', title: 'task move', status: 'claimed', claimed_by: 'codex' },
    ]);
    writeTodayInbox(root, 'inbox move');
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

test('atris next is first-minute talk, not a fake yes/no', () => {
  const root = tmp();
  try {
    const inboxTitle = 'already-known inbox line';
    writeReadyRoom(root);
    writeTodayInbox(root, inboxTitle);

    const res = runCli(['next'], root);
    assert.equal(res.status, 0, res.stderr);
    const text = spoken(res.stdout);
    assert.ok(spokenLineCount(text) <= 2, text);
    assert.match(text, /^next: atris plan$/m);
    assert.doesNotMatch(text, /Do it\?/);
    assert.doesNotMatch(text, /yes \/ no \/ skip/);
    assert.doesNotMatch(text, new RegExp(inboxTitle));
    assert.match(nextLine(text), /^atris /);
  } finally {
    cleanup(root);
  }
});

test('atris next --json is real JSON with a next command', () => {
  const root = tmp();
  try {
    const empty = runCli(['next', '--json'], root);
    assert.equal(empty.status, 0, empty.stderr);
    const fresh = JSON.parse(empty.stdout);
    assert.equal(fresh.schema, 'atris.one_lap.v1');
    assert.equal(typeof fresh.next_action, 'string');
    assert.match(fresh.next_action, /^atris /);
    assert.doesNotMatch(empty.stdout, /Do it\?/);

    writeReadyRoom(root);
    writeTaskProjection(root, [
      { id: 'task-1', display_id: 'CLI-1', title: 'claimed move', status: 'claimed', claimed_by: 'codex' },
    ]);
    const room = runCli(['next', '--json'], root);
    assert.equal(room.status, 0, room.stderr);
    const body = JSON.parse(room.stdout);
    assert.equal(body.schema, 'atris.one_lap.v1');
    assert.equal(body.next_action, 'atris task ready CLI-1 --verify "git diff --check"');
    assert.equal(body.ok, true);
  } finally {
    cleanup(root);
  }
});

test('atris next empty folder is two first-minute lines', () => {
  const root = tmp();
  try {
    const res = runCli(['next'], root);
    assert.equal(res.status, 0, res.stderr);
    const text = spoken(res.stdout);
    assert.equal(spokenLineCount(text), 2);
    assert.match(text, /this folder is empty\./);
    assert.match(text, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(text, /Nothing to do/);
    assert.doesNotMatch(text, /Do it\?/);
    assert.equal(fs.existsSync(path.join(root, 'atris')), false);
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
    assert.doesNotMatch(again.stdout, /Do it\?/);
    assert.match(again.stdout, /^next: /m);
  } finally {
    cleanup(root);
  }
});

test('leftover words after next talk first-minute and do not mint', () => {
  const root = tmp();
  try {
    const res = runCli(['next', 'hi'], root);
    assert.equal(res.status, 0, res.stderr);
    const text = spoken(res.stdout);
    assert.equal(spokenLineCount(text), 2);
    assert.match(text, /this folder is empty\./);
    assert.doesNotMatch(text, /Do it\?/);
    assert.doesNotMatch(text, /Say yes, no, or skip/);
    assert.equal(fs.existsSync(path.join(root, 'atris')), false);
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
    const text = spoken(res.stdout);
    assert.ok(spokenLineCount(text) <= 2, text);
    assert.match(text, /#2 second mission is waiting\./);
    assert.match(text, /^next: atris mission complete mission-2 --proof atris\/runs\/mission-2\.json$/m);
    assert.doesNotMatch(text, /Do it\?/);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'next_parked.jsonl')), false);
  } finally {
    cleanup(root);
  }
});
