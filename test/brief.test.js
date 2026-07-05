const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { briefOperatorGate } = require('../commands/brief');

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
