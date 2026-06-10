const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-status-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function seedWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Demo Map\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
    '# TODO.md',
    '',
    '## Backlog',
    '',
    '- **[WAIT-1]** Wait for human approval [cli]',
    '',
    '## In Progress',
    '',
    '## Completed',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      {
        display_id: 'WAIT-1',
        title: 'Wait for human approval',
        status: 'review',
        tag: 'cli',
        review: {
          approval_status: 'pending',
          agent_certified: true,
          handoff: { next_action: 'human_accept_waiting' },
        },
      },
    ],
  }), 'utf8');
}

test('status surfaces the current zero-shot route in JSON, quick, and human output', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir);

    const json = runCli(['status', '--json'], { cwd: dir });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.zero_shot.lane, 'owner_gate');
    assert.equal(payload.zero_shot.selected_ref, 'WAIT-1');
    assert.equal(payload.zero_shot.first_command, 'atris task page WAIT-1 --json');
    assert.equal(payload.zero_shot.prompt_command, 'atris 0-shot --prompt');
    assert.deepEqual(payload.zero_shot.horizon_counts, {
      now: 0,
      immediate_review: 0,
      long_term: 0,
      blocked: 1,
      orient: 0,
    });
    assert.deepEqual(payload.zero_shot.model_counts, {
      fast: 0,
      pro: 0,
      validator: 0,
      human: 1,
    });

    const quick = runCli(['status', '--quick'], { cwd: dir });
    assert.equal(quick.status, 0, quick.stderr || quick.stdout);
    assert.match(quick.stdout, /0-shot owner_gate WAIT-1/);
    assert.match(quick.stdout, /horizons now=0 review=0 long=0 blocked=1/);
    assert.match(quick.stdout, /models fast=0 pro=0 validator=0 human=1/);

    const human = runCli(['status'], { cwd: dir });
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /0-shot: owner_gate WAIT-1 -> atris task page WAIT-1 --json/);
    assert.match(human.stdout, /0-shot buckets: horizons now=0 review=0 long=0 blocked=1; models fast=0\s+pro=0 validator=0 human=1/);
  } finally {
    cleanup(dir);
  }
});
