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

test('zero-shot routes certified review rows to the human accept gate', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      {
        display_id: 'CZS-1',
        title: 'Add zero-shot CLI command',
        status: 'review',
        tag: 'cli',
        review: {
          approval_status: 'pending',
          agent_certified: true,
          handoff: { next_action: 'human_accept_waiting' },
        },
      },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'owner_gate');
    assert.equal(packet.decision.model_tier, 'human');
    assert.match(packet.decision.reason, /waiting for human accept/);
    assert.equal(packet.commands.first_command, 'atris task page CZS-1 --json');
    assert.match(packet.decision.agent_directive, /Do not mutate or accept/);
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
    assert.match(res.stdout, /prompt: atris 0-shot --prompt/);
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
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), false);
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
    assert.match(packet.handoff.prompt, /Atris 0-shot selected the next move/);
    assert.match(packet.handoff.prompt, /Run first: atris task current-step --tag cli --json/);
    assert.match(packet.handoff.prompt, /model_tier=fast/);
    assert.match(packet.handoff.prompt, /Do not human-accept/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot uses TODO.md as a read-only fallback when projection is missing', () => {
  const dir = makeTempDir();
  try {
    seedMinimalAtrisWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Plan architecture migration roadmap [architecture]',
      '',
      '## In Progress',
      '',
      '- **[T2]** Fix CLI help copy [cli]',
      '  **Claimed by:** codex',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['0-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'fast_model_task');
    assert.equal(packet.decision.selected_kind, 'todo');
    assert.equal(packet.decision.selected_ref, 'T2');
    assert.equal(packet.commands.first_command, 'atris status --json');
    assert.equal(packet.queue.total, 2);
    assert.equal(packet.queue.open, 1);
    assert.equal(packet.queue.claimed, 1);
    assert.equal(packet.routes.options[0].kind, 'todo');
    assert.equal(packet.routes.options[0].first_command, 'atris status --json');
    assert.match(packet.routes.options[0].agent_directive, /Source: atris\/TODO\.md/);
    assert.equal(packet.boundaries.no_task_mutation, true);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('0-shot aliases route to the same read-only packet', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const aliases = [
      ['0-shot', '--json'],
      ['0shot', '--json'],
      ['0', 'shot', '--json'],
      ['zeroshot', '--json'],
      ['zero', 'shot', '--json'],
    ];

    for (const alias of aliases) {
      const res = runCli(alias, { cwd: dir });
      assert.equal(res.status, 0, `${alias.join(' ')}: ${res.stderr || res.stdout}`);
      const packet = JSON.parse(res.stdout);
      assert.equal(packet.schema, 'atris.zero_shot_next_move.v1');
      assert.equal(packet.decision.lane, 'fast_model_task');
      assert.equal(packet.commands.first_command, 'atris task current-step --tag cli --json');
      assert.equal(packet.boundaries.no_task_mutation, true);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot --prompt prints only the any-model handoff prompt', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['zero-shot', '--prompt'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /^Atris 0-shot selected the next move/);
    assert.match(res.stdout, /Route: fast_model_task/);
    assert.match(res.stdout, /Run first: atris task current-step --tag cli --json/);
    assert.doesNotMatch(res.stdout, /"schema"/);
    assert.doesNotMatch(res.stdout, /0-shot next move/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('next --prompt returns the zero-shot prompt when no request is provided', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['next', '--prompt'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /^Atris 0-shot selected the next move/);
    assert.match(res.stdout, /Focus: CZS-1 - Add zero-shot CLI command/);
    assert.match(res.stdout, /Do not human-accept/);
    assert.doesNotMatch(res.stdout, /What do you want to build/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot --write refreshes durable latest packet and prompt files', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['zero-shot', '--write', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    const latestJsonPath = path.join(dir, '.atris', 'state', 'zero-shot.latest.json');
    const promptTxtPath = path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt');
    assert.equal(packet.durable.wrote, true);
    assert.equal(packet.durable.latest_json, '.atris/state/zero-shot.latest.json');
    assert.equal(packet.durable.prompt_txt, '.atris/state/zero-shot.prompt.txt');
    assert.equal(packet.boundaries.no_file_writes, false);
    assert.equal(packet.commands.zero_shot_write, 'atris 0-shot --write');
    assert.equal(packet.commands.legacy_zero_shot_write, 'atris zero-shot --write');
    assert.equal(packet.handoff.write_command, 'atris 0-shot --write');
    assert.equal(packet.handoff.legacy_write_command, 'atris zero-shot --write');
    assert.equal(packet.freshness.schema, 'atris.zero_shot_freshness.v1');
    assert.equal(typeof packet.freshness.source_fingerprint, 'string');
    assert.equal(packet.durable.source_fingerprint, packet.freshness.source_fingerprint);
    assert.equal(fs.existsSync(latestJsonPath), true);
    assert.equal(fs.existsSync(promptTxtPath), true);
    const latest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
    assert.equal(latest.schema, 'atris.zero_shot_next_move.v1');
    assert.equal(latest.generated_at, packet.generated_at);
    assert.equal(latest.handoff.prompt, packet.handoff.prompt);
    assert.equal(latest.durable.source_fingerprint, packet.freshness.source_fingerprint);
    assert.equal(fs.readFileSync(promptTxtPath, 'utf8'), `${packet.handoff.prompt}\n`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot --check reports fresh and stale durable latest files', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const write = runCli(['zero-shot', '--write'], { cwd: dir });
    assert.equal(write.status, 0, write.stderr || write.stdout);

    const freshRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(freshRes.status, 0, freshRes.stderr || freshRes.stdout);
    const fresh = JSON.parse(freshRes.stdout);
    assert.equal(fresh.schema, 'atris.zero_shot_latest_check.v1');
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.ok, true);
    assert.equal(fresh.latest_selected_ref, 'CZS-1');
    assert.equal(fresh.current_selected_ref, 'CZS-1');
    assert.equal(fresh.latest_source_fingerprint, fresh.current_source_fingerprint);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        { display_id: 'REV-1', title: 'Review the new proof', status: 'review', tag: 'cli' },
      ],
    }, null, 2));

    const staleRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(staleRes.status, 0, staleRes.stderr || staleRes.stdout);
    const stale = JSON.parse(staleRes.stdout);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.ok, false);
    assert.equal(stale.latest_selected_ref, 'CZS-1');
    assert.equal(stale.current_selected_ref, 'REV-1');
    assert.notEqual(stale.latest_source_fingerprint, stale.current_source_fingerprint);
    assert.equal(stale.refresh_command, 'atris 0-shot --write');
    assert.equal(stale.legacy_refresh_command, 'atris zero-shot --write');

    const text = runCli(['zero-shot', '--check'], { cwd: dir });
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /0-shot latest check/);
    assert.match(text.stdout, /status: stale/);
    assert.match(text.stdout, /selected: CZS-1 -> current REV-1/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot --check reports missing durable latest files', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const check = JSON.parse(res.stdout);
    assert.equal(check.status, 'missing');
    assert.equal(check.ok, false);
    assert.equal(check.latest_exists, false);
    assert.equal(check.prompt_exists, false);
    assert.equal(check.current_selected_ref, 'CZS-1');
    assert.equal(check.refresh_command, 'atris 0-shot --write');
  } finally {
    cleanupTempDir(dir);
  }
});

test('next --write refreshes the same durable zero-shot files', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);

    const res = runCli(['next', '--write', '--prompt'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /^Atris 0-shot selected the next move/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
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

test('zero-shot uses visible Codex goal when no task or mission tick is active', () => {
  const dir = makeTempDir();
  try {
    seedMinimalAtrisWorkspace(dir);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'codex_goal.json'), JSON.stringify({
      schema: 'atris.codex_goal_controller.v1',
      action: 'codex_goal_candidate',
      goal: {
        objective: 'Advance Atris mission mission-42: ship the current goal loop',
        mission_id: 'mission-42',
        mission_status: 'running',
        reason: 'active',
        next_command: 'atris mission tick mission-42 --verify --summary "<what changed>"',
      },
    }, null, 2));

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'goal_context');
    assert.equal(packet.decision.selected_kind, 'codex_goal');
    assert.equal(packet.decision.selected_ref, 'mission-42');
    assert.equal(packet.commands.first_command, 'atris mission tick mission-42 --verify --summary "<what changed>"');
    assert.equal(packet.goal.mission_id, 'mission-42');
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot does not let visible Codex goal override active task work', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'CZS-1', title: 'Add zero-shot CLI command', status: 'claimed', tag: 'cli' },
    ]);
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'codex_goal.json'), JSON.stringify({
      schema: 'atris.codex_goal_controller.v1',
      action: 'codex_goal_candidate',
      goal: {
        objective: 'Advance Atris mission mission-42: ship the current goal loop',
        mission_id: 'mission-42',
        next_command: 'atris mission tick mission-42 --verify --summary "<what changed>"',
      },
    }, null, 2));

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'fast_model_task');
    assert.equal(packet.decision.selected_kind, 'task');
    assert.equal(packet.goal.mission_id, 'mission-42');
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
    assert.equal(packet.commands.first_command, 'atris task page ARC-1 --json');
    assert.equal(packet.commands.task_page, 'atris task page ARC-1 --json');
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
    assert.equal(packet.commands.first_command, 'atris task page OWN-2 --json');
    assert.match(packet.decision.agent_directive, /Do not mutate or accept/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot surfaces blocked work before ordinary claimed work', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'FAST-1', title: 'Fix CLI help copy', status: 'claimed', tag: 'cli' },
      { display_id: 'BLK-1', title: 'Wait for customer approval before release', status: 'blocked', tag: 'release' },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'owner_gate');
    assert.equal(packet.decision.selected_ref, 'BLK-1');
    assert.equal(packet.commands.first_command, 'atris task page BLK-1 --json');
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot surfaces failed work for recovery', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'FAST-1', title: 'Fix CLI help copy', status: 'claimed', tag: 'cli' },
      { display_id: 'FAIL-1', title: 'Fix failing release gate', status: 'failed', tag: 'release' },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'recovery_lane');
    assert.equal(packet.decision.selected_ref, 'FAIL-1');
    assert.equal(packet.decision.work_size, 'recovery');
    assert.equal(packet.queue.failed, 1);
    assert.equal(packet.commands.first_command, 'atris task page FAIL-1 --json');
    assert.match(packet.decision.agent_directive, /Inspect failed task FAIL-1/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot --json includes a typed route index for mixed work', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'FAST-1', title: 'Fix CLI help copy', status: 'claimed', tag: 'cli' },
      { display_id: 'ARC-1', title: 'Plan architecture migration roadmap', status: 'claimed', tag: 'architecture' },
      { display_id: 'OWN-2', title: 'Publish release after human approval', status: 'claimed', tag: 'release' },
      { display_id: 'FAIL-1', title: 'Fix failing release gate', status: 'failed', tag: 'release' },
    ]);

    const res = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'owner_gate');
    assert.equal(packet.decision.selected_ref, 'OWN-2');
    assert.equal(packet.routes.total, 4);
    assert.equal(packet.routes.shown, 4);
    assert.equal(packet.routes.lanes.owner_gate, 1);
    assert.equal(packet.routes.lanes.recovery_lane, 1);
    assert.equal(packet.routes.lanes.fast_model_task, 1);
    assert.equal(packet.routes.lanes.long_horizon, 1);
    assert.equal(packet.routes.horizons.blocked, 1);
    assert.equal(packet.routes.horizons.now, 2);
    assert.equal(packet.routes.horizons.long_term, 1);
    assert.equal(packet.routes.models.human.count, 1);
    assert.equal(packet.routes.models.human.first.ref, 'OWN-2');
    assert.equal(packet.routes.models.human.first.first_command, 'atris task page OWN-2 --json');
    assert.equal(packet.routes.models.pro.count, 2);
    assert.equal(packet.routes.models.pro.first.ref, 'FAIL-1');
    assert.equal(packet.routes.models.fast.count, 1);
    assert.equal(packet.routes.models.fast.first.ref, 'FAST-1');
    assert.equal(packet.routes.models.validator.count, 0);
    assert.equal(packet.routes.models.validator.first, null);
    assert.deepEqual(packet.routes.options.map(route => [route.ref, route.lane, route.model_tier, route.first_command]), [
      ['OWN-2', 'owner_gate', 'human', 'atris task page OWN-2 --json'],
      ['FAIL-1', 'recovery_lane', 'pro', 'atris task page FAIL-1 --json'],
      ['FAST-1', 'fast_model_task', 'fast', 'atris task current-step --tag cli --json'],
      ['ARC-1', 'long_horizon', 'pro', 'atris task page ARC-1 --json'],
    ]);
    assert.match(packet.routes.options[0].prompt, /Route: owner_gate/);
    assert.match(packet.routes.options[1].prompt, /Run first: atris task page FAIL-1 --json/);
    assert.equal(packet.handoff.prompt, packet.routes.options[0].prompt);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.routes.options[0], 'source'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.routes.models.human.first, 'source'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.routes, 'all_options'), false);

    const fastRes = runCli(['zero-shot', '--model', 'fast', '--json'], { cwd: dir });
    assert.equal(fastRes.status, 0, fastRes.stderr || fastRes.stdout);
    const fastPacket = JSON.parse(fastRes.stdout);
    assert.equal(fastPacket.decision.requested_model_tier, 'fast');
    assert.equal(fastPacket.decision.model_tier_match, true);
    assert.equal(fastPacket.decision.selected_ref, 'FAST-1');
    assert.equal(fastPacket.decision.lane, 'fast_model_task');
    assert.equal(fastPacket.commands.first_command, 'atris task current-step --tag cli --json');
    assert.match(fastPacket.handoff.prompt, /Route: fast_model_task/);

    const fastPromptRes = runCli(['zero-shot', '--fast', '--prompt'], { cwd: dir });
    assert.equal(fastPromptRes.status, 0, fastPromptRes.stderr || fastPromptRes.stdout);
    assert.match(fastPromptRes.stdout, /Route: fast_model_task/);
    assert.match(fastPromptRes.stdout, /Focus: FAST-1 - Fix CLI help copy/);

    const proRes = runCli(['0-shot', '--pro', '--json'], { cwd: dir });
    assert.equal(proRes.status, 0, proRes.stderr || proRes.stdout);
    const proPacket = JSON.parse(proRes.stdout);
    assert.equal(proPacket.decision.requested_model_tier, 'pro');
    assert.equal(proPacket.decision.model_tier_match, true);
    assert.equal(proPacket.decision.selected_ref, 'FAIL-1');
    assert.equal(proPacket.decision.lane, 'recovery_lane');
    assert.equal(proPacket.commands.first_command, 'atris task page FAIL-1 --json');

    const missingValidatorRes = runCli(['zero-shot', '--model=validator', '--json'], { cwd: dir });
    assert.equal(missingValidatorRes.status, 0, missingValidatorRes.stderr || missingValidatorRes.stdout);
    const missingValidatorPacket = JSON.parse(missingValidatorRes.stdout);
    assert.equal(missingValidatorPacket.decision.requested_model_tier, 'validator');
    assert.equal(missingValidatorPacket.decision.model_tier_match, false);
    assert.equal(missingValidatorPacket.decision.selected_ref, null);
    assert.equal(missingValidatorPacket.decision.model_tier, 'validator');
    assert.equal(missingValidatorPacket.commands.first_command, 'atris radar --json');
    assert.equal(missingValidatorPacket.routes.models.validator.count, 0);
    assert.match(missingValidatorPacket.handoff.prompt, /No validator model route is available/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot help is workspace-free and non-mutating', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['zero-shot', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Usage: atris 0-shot/);
    assert.match(res.stdout, /Alias: atris zero-shot/);
    assert.match(res.stdout, /Also accepts: atris 0 shot, atris 0shot, atris zero shot, atris zeroshot/);
    assert.match(res.stdout, /do not know what to prompt/);
    assert.match(res.stdout, /--model fast\|pro\|validator\|human selects/);
    assert.match(res.stdout, /first_command/);
    assert.match(res.stdout, /routes\.options/);
    assert.match(res.stdout, /routes\.models/);
    assert.match(res.stdout, /handoff\.prompt/);
    assert.match(res.stdout, /--prompt prints only/);
    assert.match(res.stdout, /--write refreshes \.atris\/state\/zero-shot\.latest\.json/);
    assert.match(res.stdout, /--check compares the durable latest packet/);
    assert.match(res.stdout, /mission_tick/);
    assert.match(res.stdout, /goal_context/);
    assert.match(res.stdout, /recovery_lane/);
    assert.match(res.stdout, /owner_gate/);
    assert.match(res.stdout, /without accepting tasks or calling external systems/);
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
    assert.match(res.stdout, /atris 0-shot\s+Pick or write the next safe move/);
    assert.match(res.stdout, /zero-shot\s+- Same as 0-shot/);
    assert.match(res.stdout, /0-shot\s+- Pick or write the next safe move/);
    assert.match(res.stdout, /member activate <n>\s+- Activate a member and show the zero-shot route/);
    assert.match(res.stdout, /next\s+- Alias for zero-shot when no request is provided/);
    assert.match(res.stdout, /do not know what to prompt/);
    assert.match(res.stdout, /If you are unsure, run "atris 0-shot"/);
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
    assert.match(res.stdout, /0-shot: fast_model_task -> atris task current-step --tag cli --json \| prompt: atris 0-shot --prompt/);
    assert.match(res.stdout, /Next: atris 0-shot --prompt/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
    const latest = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json'), 'utf8'));
    assert.equal(latest.durable.wrote, true);
    assert.equal(latest.decision.selected_ref, 'CZS-1');
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
    assert.match(res.stdout, /0-shot: no_current_task -> atris radar --json \| prompt: atris 0-shot --prompt/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
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
    assert.match(res.stdout, /0-shot: fast_model_task -> atris task current-step --tag cli --json \| prompt: atris 0-shot --prompt/);
    assert.match(res.stdout, /Ready\. Run 'atris 0-shot --prompt' to choose the next move\./);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
    const latest = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json'), 'utf8'));
    assert.equal(latest.decision.selected_ref, 'CZS-1');
  } finally {
    cleanupTempDir(dir);
  }
});
