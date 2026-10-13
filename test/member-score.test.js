'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scoring = require('../lib/member-score');
const { scoreLine } = require('../scripts/det/ytrail-bench');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

const s = (value, pass = 3, total = 3) => ({ pass, total, value, unit: 's', better: 'lower' });

test('score config reads the card and clamps bad numbers', () => {
  assert.equal(scoring.scoreConfig({}), null);
  assert.deepEqual(scoring.scoreConfig({ score: 'node b.js', score_runs: '3', score_margin: '0.2' }),
    { command: 'node b.js', runs: 3, margin: 0.2 });
  assert.deepEqual(scoring.scoreConfig({ score: 'node b.js', score_runs: 'lots', score_margin: '4' }),
    { command: 'node b.js', runs: 1, margin: 0.05 });
});

test('the last score line wins and noise around it is ignored', () => {
  const out = 'bench: 3/3 passed\n{"pass":1,"total":3,"value":9}\nnoise\n{"pass":3,"total":3,"value":21.4,"unit":"s","better":"lower"}\n';
  assert.deepEqual(scoring.parseScore(out), s(21.4));
  assert.equal(scoring.parseScore('bench: 3/3 passed\n{"broken"'), null);
});

test('several runs fold to the worst pass count and the median value', () => {
  assert.deepEqual(scoring.combine([s(30), s(20, 2), s(25)]), { ...s(25, 2), runs: 3 });
});

test('better needs more passes, or the same passes and a move past the margin', () => {
  assert.equal(scoring.compare(s(30), s(20), 0.2).better, true);
  assert.equal(scoring.compare(s(30), s(27), 0.2).better, false, 'a 10% move is inside a 20% margin');
  assert.equal(scoring.compare(s(30), s(10, 2), 0.2).better, false, 'faster but a case broke');
  assert.equal(scoring.compare(s(30, 2), s(40, 3), 0.2).better, true, 'a case got fixed');
  const higher = { ...s(10), better: 'higher' };
  assert.equal(scoring.compare(higher, { ...higher, value: 13 }, 0.2).better, true);
  assert.match(scoring.compare(s(30), s(36), 0.2).reason, /30s -> 36s \(-20% worse\)/);
});

test('the gate alternates base and candidate runs and compares medians', () => {
  const calls = [];
  const runOne = (command, dir) => {
    calls.push(dir);
    return { ok: true, score: s(dir === 'base' ? 30 : 20) };
  };
  const result = scoring.gate({ command: 'x', runs: 2, margin: 0.2 }, process.cwd(), { runOne, baseDir: 'base' });
  assert.equal(result.ok, true);
  assert.equal(result.better, true);
  assert.deepEqual(calls, ['base', process.cwd(), 'base', process.cwd()]);
});

test('bench score line sums graded seconds and counts every case', () => {
  const line = JSON.parse(scoreLine([
    { graded: true, pass: true, row: { seconds: 21.4 } },
    { pass: true, row: { seconds: 4.2 } },
    { skipped: true },
  ]));
  assert.deepEqual(line, { schema: 'atris.member_score.v1', pass: 2, total: 2, value: 21.4, unit: 's', better: 'lower' });
});

// End to end in a scratch repo: a member whose score reads value.txt.
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function cli(dir, args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-score-'));
  const member = path.join(dir, 'atris', 'team', 'speedy');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), [
    '---',
    'name: speedy',
    'role: Speed Owner',
    'score: node score.js',
    'score_margin: 0.2',
    '---',
    '',
    '# Mission',
    '',
    'Make the number smaller.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(member, 'goals.json'), JSON.stringify({
    schema: 'atris.member_goals.v1',
    goals: [{
      id: 'g1',
      title: 'Faster',
      status: 'active',
      acceptance: ['the score drops'],
      experiments: [
        { id: 'e1', title: 'Cut the wait', status: 'proposed' },
        { id: 'e2', title: 'Trim a little', status: 'proposed' },
      ],
    }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'score.js'),
    "const v = Number(require('fs').readFileSync(__dirname + '/value.txt', 'utf8'));\n"
    + "console.log(JSON.stringify({ pass: 1, total: 1, value: v, unit: 's', better: 'lower' }));\n");
  fs.writeFileSync(path.join(dir, 'value.txt'), '100');
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return dir;
}

test('member score --gate and review --auto keep only a real gain', () => {
  const dir = scratchRepo();
  try {
    const none = cli(dir, ['member', 'score', 'speedy', '--gate']);
    assert.equal(none.status, 2, 'no change on top of master is nothing to judge');
    assert.match(none.stderr, /nothing to compare/);

    fs.writeFileSync(path.join(dir, 'value.txt'), '50');
    const gate = cli(dir, ['member', 'score', 'speedy', '--gate', '--json']);
    assert.equal(gate.status, 0, gate.stderr || gate.stdout);
    const payload = JSON.parse(gate.stdout);
    assert.equal(payload.better, true);
    assert.equal(payload.base.value, 100);
    assert.equal(payload.candidate.value, 50);

    const keep = cli(dir, ['member', 'review', 'speedy', 'e1', '--auto', '--json']);
    assert.equal(keep.status, 0, keep.stderr || keep.stdout);
    const kept = JSON.parse(keep.stdout);
    assert.equal(kept.outcome, 'accepted');
    assert.equal(kept.experiment.judged_by, 'score_gate');
    assert.match(kept.experiment.proof, /score gate better: 100s -> 50s/);

    fs.writeFileSync(path.join(dir, 'value.txt'), '95');
    const small = cli(dir, ['member', 'score', 'speedy', '--gate']);
    assert.equal(small.status, 1, 'a 5% move is inside the 20% margin');
    const drop = cli(dir, ['member', 'review', 'speedy', 'e2', '--auto', '--json']);
    assert.equal(drop.status, 0, drop.stderr || drop.stdout);
    assert.equal(JSON.parse(drop.stdout).outcome, 'discarded');

    const history = scoring.readHistory('speedy', dir);
    assert.equal(history.filter((row) => row.kind === 'gate').length, 4);
    assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'the base checkout is cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review --auto refuses a member with no score command', () => {
  const dir = scratchRepo();
  try {
    const card = path.join(dir, 'atris', 'team', 'speedy', 'MEMBER.md');
    fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace('score: node score.js\n', ''));
    const r = cli(dir, ['member', 'review', 'speedy', 'e1', '--auto']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no score command/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
