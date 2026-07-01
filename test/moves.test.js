'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nextMoves = require('../lib/next-moves');
const { parseIndexes } = require('../commands/moves');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-moves-'));
}
function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}
function writeRoadmap(root, items) {
  const body = items.map((i) => `- [ ] ${i}`).join('\n');
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), `# Roadmap\n\n## Open loop items\n\n${body}\n\n## Other\n\ntext\n`, 'utf8');
}
function writeTaskProjection(root, tasks) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({ tasks }), 'utf8');
}
function writeMissions(root, missions) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), missions.map((m) => JSON.stringify(m)).join('\n'), 'utf8');
}
function writeLatestInbox(root, lines) {
  const logDir = path.join(root, 'atris', 'logs', '2099');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, '2099-01-01.md'), `# Log 2099-01-01\n\n## Inbox\n\n${lines.join('\n')}\n`, 'utf8');
}
function writeReport(root, name, text) {
  const reportsDir = path.join(root, 'atris', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, name), text, 'utf8');
}

test('pickNextMoves ranks roadmap over task over inbox, and dedupes', () => {
  const cands = [
    { title: 'inbox idea', why: 'x', source: 'inbox', weight: 40 },
    { title: 'goal item', why: 'x', source: 'roadmap', weight: 100 },
    { title: 'task in flight', why: 'x', source: 'task', weight: 60 },
    { title: 'goal item', why: 'dup', source: 'roadmap', weight: 100 },
  ];
  const picks = nextMoves.pickNextMoves(cands, { limit: 3 });
  assert.deepEqual(picks.map((p) => p.source), ['roadmap', 'task', 'inbox']);
  assert.equal(picks.length, 3, 'dedup dropped the duplicate goal item');
});

test('pickNextMoves drops killed ids', () => {
  const cands = [{ title: 'a', why: 'x', source: 'roadmap', weight: 100 }];
  const id = nextMoves.moveId('roadmap', 'a');
  assert.equal(nextMoves.pickNextMoves(cands, { killedIds: [id] }).length, 0);
});

test('moveId is stable and case-insensitive on title', () => {
  assert.equal(nextMoves.moveId('roadmap', 'Do The Thing'), nextMoves.moveId('roadmap', 'do the thing'));
});

test('seedInboxFromMove writes an I# item under today\'s Inbox', () => {
  const root = tmp();
  try {
    const res = nextMoves.seedInboxFromMove(root, { title: 'ship the loop', source: 'roadmap' });
    const content = fs.readFileSync(res.file, 'utf8');
    assert.match(content, /## Inbox/);
    assert.match(content, /- \*\*I1:\*\* ship the loop/);
    // second seed increments the id
    const res2 = nextMoves.seedInboxFromMove(root, { title: 'second', source: 'roadmap' });
    assert.equal(res2.nextId, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readRoadmapOpenItems reads only the unchecked items in the section', () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'ROADMAP.md'),
      '# R\n\n## Open loop items\n\n- [ ] alpha\n- [x] done already\n- [ ] beta\n\n## Next\n\n- [ ] not in scope\n', 'utf8');
    const items = nextMoves.readRoadmapOpenItems(root).map((i) => i.title);
    assert.deepEqual(items, ['alpha', 'beta']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readEndgameMove suppresses compiled endgame when TODO has no active endgame work', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'atris', 'brain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'brain', 'state.json'), JSON.stringify({
      endgame: { horizon: 'stale endgame', source: 'old compiled state' },
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** stale-endgame',
      '**Horizon:** stale endgame',
      '',
      '## Backlog',
      '',
      '- **T1:** real non-endgame task [execute]',
      '',
    ].join('\n'), 'utf8');

    assert.deepEqual(nextMoves.readEndgameMove(root), []);
    assert.ok(!nextMoves.nextMoves(root, 5).some((move) => move.title === 'stale endgame'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readEndgameMove keeps compiled endgame when active endgame work remains', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'atris', 'brain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'brain', 'state.json'), JSON.stringify({
      endgame: { horizon: 'live endgame', source: 'active task' },
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** live-endgame',
      '**Horizon:** live endgame',
      '',
      '## Backlog',
      '',
      '- **T1:** live endgame step [endgame] [execute]',
      '',
    ].join('\n'), 'utf8');

    const moves = nextMoves.readEndgameMove(root);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].title, 'live endgame');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris moves --json` surfaces roadmap open items', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['first move', 'second move']);
    const res = runCli(['moves', '--json'], root);
    assert.equal(res.status, 0, res.stderr);
    const moves = JSON.parse(res.stdout).moves;
    assert.equal(moves[0].title, 'first move');
    assert.equal(moves[0].source, 'roadmap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris moves --approve` seeds the move into the inbox the loop reads', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['approved move']);
    const res = runCli(['moves', '--approve', '1'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /approved: approved move/);
    // the move now lives in today's inbox
    const logsDir = path.join(root, 'atris', 'logs');
    const year = fs.readdirSync(logsDir)[0];
    const file = fs.readdirSync(path.join(logsDir, year))[0];
    const journal = fs.readFileSync(path.join(logsDir, year, file), 'utf8');
    assert.match(journal, /## Inbox/);
    assert.match(journal, /approved move/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris moves --kill` stops suggesting that move', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['keep me', 'kill me']);
    let res = runCli(['moves', '--kill', '2'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /killed: kill me/);
    res = runCli(['moves', '--json'], root);
    const titles = JSON.parse(res.stdout).moves.map((m) => m.title);
    assert.ok(titles.includes('keep me'));
    assert.ok(!titles.includes('kill me'), 'killed move should not reappear');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickNextMoves suppresses a killed title across sources', () => {
  const cands = [
    { title: 'ship it', source: 'roadmap', weight: 100 },
    { title: 'ship it', source: 'inbox', weight: 40 },
  ];
  const killedId = nextMoves.moveId('roadmap', 'ship it');
  const picks = nextMoves.pickNextMoves(cands, { killedIds: [killedId], killedTitles: ['ship it'] });
  assert.equal(picks.length, 0, 'same title from a different source stays suppressed');
});

test('pickNextMoves suppresses approved moves so they stop nagging', () => {
  const cands = [{ title: 'approved one', source: 'roadmap', weight: 100 }];
  assert.equal(nextMoves.pickNextMoves(cands, { approvedTitles: ['approved one'] }).length, 0);
});

test('killing or approving an idea never hides a real task with the same title', () => {
  const cands = [
    { title: 'fix login', source: 'roadmap', weight: 100 },
    { title: 'fix login', source: 'task', weight: 60, ref: 'CLI-42' },
  ];
  // kill the roadmap idea by its id + title
  const killed = nextMoves.pickNextMoves(cands, { killedIds: [nextMoves.moveId('roadmap', 'fix login')], killedTitles: ['fix login'] });
  assert.equal(killed.length, 1);
  assert.equal(killed[0].source, 'task', 'the genuine in-flight task survives');
  // same for approve
  const approved = nextMoves.pickNextMoves(cands, { approvedIds: [nextMoves.moveId('roadmap', 'fix login')], approvedTitles: ['fix login'] });
  assert.equal(approved.length, 1);
  assert.equal(approved[0].source, 'task');
});

test('nextMoves suppresses reviewed task receipt fragments from inbox', () => {
  const root = tmp();
  try {
    writeTaskProjection(root, [
      { display_id: 'CLI-1', title: 'Make task accept landing concise', status: 'review' },
      { display_id: 'CLI-2', title: 'Active same title', status: 'claimed', claimed_by: 'auto-improver' },
    ]);
    writeLatestInbox(root, [
      '- **I1:** live idea',
      '- task: CLI-1',
      '- title: Make task accept landing concise',
      '- status: done',
      '- proof: already shipped',
      '- title: Active same title',
    ]);

    const moves = nextMoves.nextMoves(root, 10);
    const titles = moves.map((m) => m.title);

    assert.ok(titles.includes('live idea'), 'real inbox ideas still show');
    assert.ok(!titles.includes('Make task accept landing concise'), 'reviewed task title is not suggested again');
    assert.ok(!titles.some((title) => /^(task|status|proof):/i.test(title)), 'task receipt metadata is not suggested');
    const active = moves.find((m) => m.title === 'Active same title');
    assert.equal(active?.source, 'task', 'real active task survives even when inbox has the same title');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nextMoves drops generic tick placeholders but keeps concrete inbox ideas', () => {
  const root = tmp();
  try {
    writeLatestInbox(root, [
      '- **I1:** dogfood tick',
      '- **I2:** ship receipt timeline',
      '- **I3:** run one tick',
      '- **I4:** test idea',
    ]);

    const titles = nextMoves.nextMoves(root, 10).map((m) => m.title);
    assert.ok(!titles.includes('dogfood tick'), 'vague dogfood placeholder is not a next move');
    assert.ok(!titles.includes('run one tick'), 'generic tick command is not a next move');
    assert.ok(!titles.includes('test idea'), 'test placeholder is not a next mission');
    assert.ok(titles.includes('ship receipt timeline'), 'concrete inbox ideas still show');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nextMoves hides Mission XP bookkeeping but keeps real active tasks', () => {
  const root = tmp();
  try {
    writeTaskProjection(root, [
      { display_id: 'CLI-1', title: 'Mission XP: overnight self improvement', status: 'claimed', tag: 'agent-xp', claimed_by: 'auto-improver' },
      { display_id: 'CLI-2', title: 'Fix the real loop card', status: 'claimed', tag: 'loop', claimed_by: 'auto-improver' },
    ]);

    const moves = nextMoves.nextMoves(root, 10);
    const titles = moves.map((m) => m.title);
    assert.ok(!titles.includes('Mission XP: overnight self improvement'), 'internal AgentXP task is not a next move');
    assert.equal(moves.find((m) => m.title === 'Fix the real loop card')?.source, 'task');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nextMoves adds a seed when only an active mission remains', () => {
  const root = tmp();
  try {
    writeMissions(root, [
      { id: 'mission-1', objective: 'overnight mission', status: 'ready', owner: 'auto-improver' },
    ]);

    let moves = nextMoves.nextMoves(root, 3);
    assert.equal(moves[0].title, 'overnight mission');
    assert.equal(moves[1].title, nextMoves.SELF_IMPROVEMENT_SEED_TITLE);
    assert.equal(moves[1].why, 'active mission has no concrete task queued');

    writeTaskProjection(root, [
      { display_id: 'CLI-2', title: 'Fix the real loop card', status: 'claimed', tag: 'loop', claimed_by: 'auto-improver' },
    ]);
    moves = nextMoves.nextMoves(root, 3);
    assert.ok(moves.some((m) => m.title === 'Fix the real loop card'));
    assert.ok(!moves.some((m) => m.title === nextMoves.SELF_IMPROVEMENT_SEED_TITLE), 'real work suppresses the fallback seed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nextMoves uses the latest report suggested target for mission-only seed', () => {
  const root = tmp();
  try {
    writeMissions(root, [
      { id: 'mission-1', objective: 'overnight mission', status: 'ready', owner: 'auto-improver' },
    ]);
    writeReport(root, '2099-01-01-old.md', 'Suggested target: old target.\n');
    writeReport(root, '2099-01-02-new.md', [
      '# Proof',
      '',
      'Suggested target: teach the loop to create the next task from evidence.',
      '',
    ].join('\n'));

    const moves = nextMoves.nextMoves(root, 3);
    assert.equal(moves[1].title, 'Teach the loop to create the next task from evidence');
    assert.equal(moves[1].why, 'latest proof timeline suggested this self-improvement target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nextMoves rejects placeholder report targets for mission-only seed', () => {
  const root = tmp();
  try {
    writeMissions(root, [
      { id: 'mission-1', objective: 'overnight mission', status: 'ready', owner: 'auto-improver' },
    ]);
    writeReport(root, '2099-01-02-new.md', [
      '# Proof',
      '',
      'Suggested target: test idea.',
      '',
    ].join('\n'));

    const moves = nextMoves.nextMoves(root, 3);
    assert.equal(moves[1].title, nextMoves.SELF_IMPROVEMENT_SEED_TITLE);
    assert.doesNotMatch(moves.map((move) => move.title).join('\n'), /test idea/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pickNextMoves keeps the highest-weight copy of a duplicated title', () => {
  const cands = [
    { title: 'dup', source: 'inbox', weight: 40 },
    { title: 'dup', source: 'roadmap', weight: 100 },
  ];
  const picks = nextMoves.pickNextMoves(cands, {});
  assert.equal(picks.length, 1);
  assert.equal(picks[0].source, 'roadmap', 'sort-before-dedup keeps the roadmap copy');
});

test('`atris moves --approve` then --json no longer shows the approved move', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['keep me too', 'approve me']);
    runCli(['moves', '--approve', '2'], root);
    const res = runCli(['moves', '--json'], root);
    const titles = JSON.parse(res.stdout).moves.map((m) => m.title);
    assert.ok(!titles.includes('approve me'), 'approved move should be suppressed, not nag');
    assert.ok(titles.includes('keep me too'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('`atris moves --approve` claims the roadmap item ([~]) so the loop agrees it is handled', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['approve me', 'keep me']);
    const res = runCli(['moves', '--approve', '1'], root);
    assert.equal(res.status, 0, res.stderr);
    const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');
    assert.match(roadmap, /- \[~\] approve me/, 'approved roadmap move is claimed in ROADMAP');
    assert.match(roadmap, /- \[ \] keep me/, 'the other item stays open');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSelection prefers a stable id, falls back to position, ignores garbage', () => {
  const { resolveSelection } = require('../commands/moves');
  const moves = nextMoves.pickNextMoves([
    { title: 'a', source: 'roadmap', weight: 100 },
    { title: 'b', source: 'roadmap', weight: 90 },
  ], {});
  assert.deepEqual(resolveSelection(moves, moves[1].id).map((m) => m.title), ['b'], 'resolves by stable id');
  assert.deepEqual(resolveSelection(moves, '1').map((m) => m.title), ['a'], 'positional fallback');
  assert.deepEqual(resolveSelection(moves, '99'), [], 'out of range');
  assert.deepEqual(resolveSelection(moves, 'nope'), [], 'garbage');
});

test('`atris moves --kill <id>` kills exactly that move regardless of position', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['first', 'second']);
    const secondId = JSON.parse(runCli(['moves', '--json'], root).stdout).moves.find((m) => m.title === 'second').id;
    const res = runCli(['moves', '--kill', secondId], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /killed: second/);
    const after = JSON.parse(runCli(['moves', '--json'], root).stdout).moves.map((m) => m.title);
    assert.ok(!after.includes('second'), 'the id-targeted move is gone');
    assert.ok(after.includes('first'), 'the other move stays');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseIndexes parses lists and drops non-positive / garbage', () => {
  assert.deepEqual(parseIndexes('abc'), []);
  assert.deepEqual(parseIndexes('0'), []);
  assert.deepEqual(parseIndexes('1, 3'), [1, 3]);
  assert.deepEqual(parseIndexes(''), []);
});

test('`atris moves --approve 99` (out of range) seeds nothing and says so', () => {
  const root = tmp();
  try {
    writeRoadmap(root, ['only one']);
    const res = runCli(['moves', '--approve', '99'], root);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no matching move/);
    assert.equal(fs.existsSync(path.join(root, 'atris', 'logs')), false, 'nothing should be seeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
