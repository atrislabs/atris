const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zero-shot-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
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

function seedMinimalAtrisWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n- bin/atris.js:1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Backlog\n\n## In Progress\n\n## Completed\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'atris', 'PERSONA.md'), '# Persona\n', 'utf8');
}

function seedWorkspace(dir, tasks) {
  seedMinimalAtrisWorkspace(dir);
  fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), [
    '# Status',
    '',
    '## Strongest Signal',
    '- Review proof should be drained before new work.',
    '',
    '## Next Move',
    '- Verify the waiting CLI proof.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks,
  }, null, 2));
}

test('zero-shot --json selects review-lane work without mutating projection files', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Implement small CLI command', status: 'claimed', tag: 'cli' },
      { display_id: 'REV-1', title: 'Review pending proof', status: 'review', tag: 'cli' },
    ]);
    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const before = fs.readFileSync(projectionPath, 'utf8');

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.schema, 'atris.zero_shot_next_move.v1');
    assert.equal(packet.decision.lane, 'review_lane');
    assert.equal(packet.decision.horizon, 'immediate_review');
    assert.equal(packet.decision.model_tier, 'validator');
    assert.match(packet.decision.agent_directive, /Verify REV-1/);
    assert.equal(packet.decision.selected_ref, 'REV-1');
    assert.equal(packet.commands.next_command, 'atris task review-chat REV-1 --as codex-review');
    assert.equal(packet.commands.first_command, packet.commands.next_command);
    assert.equal(packet.boundaries.no_task_mutation, true);
    assert.equal(fs.readFileSync(projectionPath, 'utf8'), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot falls back to radar when no current task exists', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['zero-shot'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /0-shot next move/);
    assert.match(res.stdout, /route: no_current_task/);
    assert.match(res.stdout, /run: atris radar --json/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('next without a request is a zero-shot shortcut', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['next'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /0-shot next move/);
    assert.match(res.stdout, /run: atris radar --json/);
    assert.doesNotMatch(res.stdout, /What do you want to build/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('next --json returns the zero-shot packet for agents', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['next', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.schema, 'atris.zero_shot_next_move.v1');
    assert.equal(packet.commands.first_command, 'atris task current-step --tag cli --json');
    assert.equal(packet.decision.lane, 'fast_model_task');
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot routes active missions needing verification before task work', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);
    const missionsPath = path.join(dir, '.atris', 'state', 'missions.jsonl');
    fs.writeFileSync(missionsPath, `${JSON.stringify({
      id: 'mission-1',
      owner: 'mission-lead',
      objective: 'Keep the long horizon launch loop moving',
      status: 'running',
      verifier: 'npm test',
      verifier_result: { passed: false },
    })}\n`);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'mission_tick');
    assert.equal(packet.decision.horizon, 'long_term');
    assert.equal(packet.decision.model_tier, 'pro');
    assert.equal(packet.decision.selected_kind, 'mission');
    assert.equal(packet.decision.selected_ref, 'mission-1');
    assert.equal(packet.commands.first_command, 'atris mission tick mission-1 --verify --complete-on-pass');
    assert.equal(packet.missions.needs_tick, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot does not let generic brain status override the active task lane', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), [
      '# Status',
      '',
      '## Strongest Signal',
      '- Loop health sees active channels: Task plane, Missions, Codex goal.',
      '',
      '## Next Move',
      '- Pick the current task.',
      '',
    ].join('\n'));

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'fast_model_task');
    assert.equal(packet.commands.next_command, 'atris task current-step --tag cli --json');
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot does not treat product owner wording as an owner gate', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'OWN-1', title: 'Update owner computer command help', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'fast_model_task');
    assert.equal(packet.decision.model, 'fast');
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot routes long-horizon work to pro planning context', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'ARC-1', title: 'Plan architecture migration roadmap', status: 'claimed', tag: 'architecture' },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'long_horizon');
    assert.equal(packet.decision.horizon, 'long_term');
    assert.equal(packet.decision.work_size, 'long');
    assert.equal(packet.decision.model_tier, 'pro');
    assert.match(packet.decision.agent_directive, /stronger model/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot routes owner-gated work to the human lane', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'OWN-2', title: 'Publish release after human approval', status: 'claimed', tag: 'release' },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'owner_gate');
    assert.equal(packet.decision.horizon, 'blocked');
    assert.equal(packet.decision.model_tier, 'human');
    assert.match(packet.decision.agent_directive, /Do not mutate or accept/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot help is workspace-free and non-mutating', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['zero-shot', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris zero-shot/);
    assert.match(res.stdout, /do not know what to prompt/);
    assert.match(res.stdout, /first_command/);
    assert.match(res.stdout, /mission_tick/);
    assert.match(res.stdout, /owner_gate/);
    assert.match(res.stdout, /without writing state/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('top-level help advertises zero-shot for uncertain starts', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /atris zero-shot\s+Pick the next safe move/);
    assert.match(res.stdout, /member activate <n>\s+- Activate a member and show the zero-shot route/);
    assert.match(res.stdout, /next\s+- Alias for zero-shot when no request is provided/);
    assert.match(res.stdout, /do not know what to prompt/);
    assert.match(res.stdout, /If you are unsure, run "atris zero-shot"/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('activate surfaces the zero-shot next route', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['activate'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /0-shot: fast_model_task -> atris task current-step --tag cli --json/);
    assert.match(res.stdout, /Next: atris zero-shot/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('bare atris cold start surfaces zero-shot before prompting', () => {
  const dir = makeTempDir();
  try {
    seedMinimalAtrisWorkspace(dir);

    const res = runCli([], { cwd: dir, input: '\n' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /CONTEXT LOADED/);
    assert.match(res.stdout, /0-shot: no_current_task -> atris radar --json/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris.md boot visualization points initialized workspaces at zero-shot', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['atris.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /WORKSPACE DETECTED/);
    assert.match(res.stdout, /0-shot: fast_model_task -> atris task current-step --tag cli --json/);
    assert.match(res.stdout, /Ready\. Run 'atris zero-shot' to choose the next move\./);
  } finally {
    cleanupTempDir(dir);
  }
});
