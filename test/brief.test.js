'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const autoland = require('../lib/autoland');
const { briefOperatorGate } = require('../commands/brief');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brief-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedState(dir) {
  const now = Date.now();
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      {
        id: 'task-1',
        display_id: 'CLI-1',
        title: 'CLI-991 fix `node --test` 01HZY3ZX4QJBPXG6NQ9M7K2T1P commands/brief.js:44 so the operator can read it.',
        status: 'done',
        claimed_by: 'agent-one',
        updated_at: new Date(now).toISOString(),
        done_at: new Date(now).toISOString(),
        metadata: {
          latest_agent_proof: [
            'node --test test/brief.test.js -> pass 12/12.',
            'npm test passed.',
            'PR https://github.com/atrislabs/atris-cli/pull/123 merged.',
          ].join(' '),
          agent_certified: true,
        },
      },
      {
        id: 'task-2',
        display_id: 'CLI-2',
        title: 'review the handoff so the launch does not wait',
        status: 'review',
        claimed_by: 'agent-two',
        updated_at: new Date(now).toISOString(),
        metadata: {
          assigned_to: 'agent-two',
          latest_agent_proof: 'verified after review',
        },
      },
      {
        id: 'task-3',
        display_id: 'CLI-3',
        title: 'keep the board moving so the team stays unblocked',
        status: 'claimed',
        updated_at: new Date(now).toISOString(),
        metadata: {
          assigned_to: 'agent-one',
        },
      },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(stateDir, 'missions.jsonl'), `${JSON.stringify({
    id: 'mission-1',
    owner: 'mission-lead',
    runner: 'codex',
    objective: 'CLI-555 keep the operator current through commands/brief.js:91',
    status: 'running',
  })}\n`);
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_BRIEF_NO_OPEN: '1',
    },
  });
}

test('brief --json groups recent tasks by agent and bucket', () => {
  const dir = makeTempDir();
  try {
    seedState(dir);
    const result = runCli(['brief', '--json'], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(result.stdout);
    const agents = Object.fromEntries(data.agents.map(agent => [agent.agent, agent]));
    assert.equal(agents['agent-one'].buckets.landed.length, 1);
    assert.equal(agents['agent-one'].buckets.working_now.length, 1);
    assert.equal(agents['agent-two'].buckets.in_review.length, 1);
    assert.equal(data.waiting_on_you.length, 1);
    assert.equal(data.missions.length, 1);
    assert.equal(data.totals.landed, 1);
    assert.equal(data.totals.in_review, 1);
    assert.equal(data.totals.working, 1);
    assert.equal(data.totals.active_missions, 1);
  } finally {
    cleanup(dir);
  }
});

test('brief writes operator html without raw ids, paths, commands, or proof dumps', () => {
  const dir = makeTempDir();
  try {
    seedState(dir);
    const out = path.join(dir, 'b.html');
    const result = runCli(['brief', '--out', out], dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(out));
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /what your team did/);
    assert.match(html, /agent-one/);
    assert.match(html, /the operator can read it/);
    assert.match(html, /<a href="https:\/\/github\.com\/atrislabs\/atris-cli\/pull\/123"[^>]*>pr #123<\/a>/);
    assert.match(html, />verified</);
    assert.doesNotMatch(html, /[0-9A-HJKMNP-TV-Z]{20}/);
    assert.doesNotMatch(html, /\b[A-Z]{2,4}-\d+\b/);
    assert.doesNotMatch(html, /node --test/);
    assert.doesNotMatch(html, /npm test/);
    assert.doesNotMatch(html, /\.js:/);
    assert.doesNotMatch(html, /--/);
  } finally {
    cleanup(dir);
  }
});

test('briefOperatorGate blocks raw operator jargon as a hard error', () => {
  assert.throws(() => briefOperatorGate(['CLI-991 leaked']), /ticket id/);
  assert.throws(() => briefOperatorGate(['node --test leaked']), /shell fragment/);
  assert.throws(() => briefOperatorGate(['commands/brief.js:44 leaked']), /file path/);
});

test('brief prefers stored result sentences over task titles', () => {
  const digest = autoland.composeDigest({
    accepted: {
      auto: [{
        ref: 'CLI-1',
        title: 'Add --brief-result flag to commands/task.js',
        result: 'Operators can now approve finished work faster because each row names the human result.',
        member: 'codex',
      }],
      human: [],
    },
    waiting: [],
    landed: null,
    project: 'atris-cli',
  });
  assert.match(digest, /operators can now approve finished work faster/);
  assert.doesNotMatch(digest, /brief-result|commands\/task\.js/);
  assert.match(digest, /1 landed \(1 explained\)/);
});

test('brief hides jargon-only landed titles and counts unexplained work', () => {
  const digest = autoland.composeDigest({
    accepted: {
      auto: [
        { ref: 'CLI-1', title: 'Add --json flag to commands/task.js', member: 'codex' },
        { ref: 'CLI-2', title: 'CLI-123 repair task_result_projection', member: 'codex' },
      ],
      human: [],
    },
    waiting: [],
    landed: null,
    project: 'atris-cli',
  });
  assert.match(digest, /2 landed \(0 explained\)/);
  assert.match(digest, /2 more landed from codex that could not explain themselves yet/);
  assert.doesNotMatch(digest, /commands\/task\.js|task_result_projection|--json|CLI-123/);
});

test('brief hides jargon-only review titles and counts unexplained review work', () => {
  const digest = autoland.composeDigest({
    accepted: { auto: [], human: [] },
    waiting: [
      { ref: 'CLI-3', title: 'Wire --accept-all to task_result_projection', member: 'validator', hours: 4 },
    ],
    landed: null,
    project: 'atris-cli',
  });
  assert.match(digest, /waiting on you \(0 explained\/1 total/);
  assert.match(digest, /1 more in review from validator that could not explain themselves yet/);
  assert.doesNotMatch(digest, /task_result_projection|--accept-all/);
});

test('mission brief line uses visible goal before objective', () => {
  const line = autoland.missionDigestLine({
    objective: 'CLI-888 run mission_status_sync',
    visible_goal: {
      desired_objective: 'Operators can now see the mission result faster because the goal is written plainly.',
    },
  });
  assert.equal(line, 'Operators can now see the mission result faster because the goal is written plainly.');
});

test('brief truncation drops dangling fragments', () => {
  const digest = autoland.composeDigest({
    accepted: {
      auto: [{
        ref: 'CLI-4',
        title: 'Operators save time because the brief keeps readable context (with an unfinished fragment that would otherwise trail and',
      }],
      human: [],
    },
    waiting: [],
    landed: null,
    project: 'atris-cli',
  });
  for (const line of digest.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    assert.doesNotMatch(line, /\($/);
    assert.doesNotMatch(line, /\b(after|with|and|or|to|for)[.!?]?$/i);
    assert.ok(!(line.includes('(') && !line.includes(')')), `dangling open paren in: ${line}`);
  }
});
