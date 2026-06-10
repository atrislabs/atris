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

function overflowRouteTasks() {
  return [
    ...Array.from({ length: 8 }, (_, index) => ({
      display_id: `FAST-${index + 1}`,
      title: `Fix CLI help copy ${index + 1}`,
      status: 'claimed',
      tag: `cli${index + 1}`,
    })),
    { display_id: 'ARC-9', title: 'Plan architecture migration roadmap', status: 'claimed', tag: 'architecture' },
    { display_id: 'FAST-10', title: 'Fix CLI help copy 10', status: 'claimed', tag: 'cli10' },
  ];
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
    assert.equal(packet.decision.owner_action, 'human-only: atris task accept CZS-1');
    assert.equal(packet.decision.safe_agent_action, 'read-only: atris task page CZS-1 --json; then wait or pick a non-blocked route from atris 0-shot --all');
    assert.match(packet.handoff.prompt, /Owner action: human-only: atris task accept CZS-1/);
    assert.match(packet.handoff.prompt, /Agent-safe action: read-only: atris task page CZS-1 --json/);
    assert.match(packet.handoff.prompt, /do not cross the owner gate/);
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
    assert.match(res.stdout, /horizons: now=0 immediate_review=0 long_term=0 blocked=0 orient=0/);
    assert.match(res.stdout, /models: fast=0 pro=0 validator=0 human=0/);
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
    assert.match(packet.handoff.prompt, /Queue: total=1 open=0 claimed=1 review=0 blocked=0 failed=0 done=0/);
    assert.match(packet.handoff.prompt, /Route inventory: total=1 compact=1 hidden=0 full_field=routes\.all_options/);
    assert.match(packet.handoff.prompt, /Horizon buckets: now=1 review=0 long=0 blocked=0 orient=0/);
    assert.match(packet.handoff.prompt, /First routes by horizon: now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(packet.handoff.prompt, /Model buckets: fast=1 pro=0 validator=0 human=0/);
    assert.match(packet.handoff.prompt, /First routes by model: fast=CZS-1\/fast pro=none validator=none human=none/);
    assert.match(packet.handoff.prompt, /Inspect all routes before switching lanes: atris 0-shot --all/);
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

test('zero-shot includes TODO routes as read-only options beside task projection work', () => {
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
      '## Review',
      '',
      '(Empty)',
      '',
      '## Blocked',
      '',
      '- **[B1]** Waiting for billing owner approval [billing]',
      '',
      '## Completed',
      '',
      '- **[D1]** Completed historical task [cli]',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['0-shot', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const packet = JSON.parse(res.stdout);
    assert.equal(packet.decision.lane, 'owner_gate');
    assert.equal(packet.decision.selected_kind, 'task');
    assert.equal(packet.decision.selected_ref, 'CZS-1');
    assert.equal(packet.queue.total, 4);
    assert.equal(packet.queue.open, 1);
    assert.equal(packet.queue.claimed, 1);
    assert.equal(packet.queue.review, 1);
    assert.equal(packet.queue.blocked, 1);
    assert.equal(packet.queue.done, 0);
    assert.equal(packet.routes.total, 4);
    assert.deepEqual(packet.routes.all_options.map(route => [route.kind, route.ref, route.lane, route.model_tier, route.first_command]), [
      ['task', 'CZS-1', 'owner_gate', 'human', 'atris task page CZS-1 --json'],
      ['todo', 'B1', 'owner_gate', 'human', 'atris status --json'],
      ['todo', 'T2', 'fast_model_task', 'fast', 'atris status --json'],
      ['todo', 'T1', 'long_horizon', 'pro', 'atris status --json'],
    ]);
    assert.equal(packet.routes.horizon_first.now.ref, 'T2');
    assert.equal(packet.routes.horizon_first.long_term.ref, 'T1');
    assert.equal(packet.routes.horizon_first.blocked.ref, 'CZS-1');
    assert.equal(packet.routes.models.fast.first.ref, 'T2');
    assert.equal(packet.routes.models.pro.first.ref, 'T1');
    assert.equal(packet.routes.models.human.count, 2);
    assert.match(packet.routes.models.fast.first.agent_directive, /Source: atris\/TODO\.md/);

    const fastRes = runCli(['0-shot', '--model', 'fast', '--json'], { cwd: dir });
    assert.equal(fastRes.status, 0, fastRes.stderr || fastRes.stdout);
    const fastPacket = JSON.parse(fastRes.stdout);
    assert.equal(fastPacket.decision.selected_kind, 'todo');
    assert.equal(fastPacket.decision.selected_ref, 'T2');
    assert.equal(fastPacket.decision.lane, 'fast_model_task');
    assert.equal(fastPacket.commands.first_command, 'atris status --json');

    const longRes = runCli(['0-shot', '--horizon', 'long', '--json'], { cwd: dir });
    assert.equal(longRes.status, 0, longRes.stderr || longRes.stdout);
    const longPacket = JSON.parse(longRes.stdout);
    assert.equal(longPacket.decision.selected_kind, 'todo');
    assert.equal(longPacket.decision.selected_ref, 'T1');
    assert.equal(longPacket.decision.lane, 'long_horizon');
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
    assert.match(res.stdout, /Queue: total=1 open=0 claimed=1 review=0 blocked=0 failed=0 done=0/);
    assert.match(res.stdout, /Route inventory: total=1 compact=1 hidden=0 full_field=routes\.all_options/);
    assert.match(res.stdout, /First routes by horizon: now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(res.stdout, /First routes by model: fast=CZS-1\/fast pro=none validator=none human=none/);
    assert.match(res.stdout, /Selection prompts: atris 0-shot --model fast\|pro\|validator\|human --prompt/);
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
    assert.match(res.stdout, /Queue: total=1 open=0 claimed=1 review=0 blocked=0 failed=0 done=0/);
    assert.match(res.stdout, /Horizon buckets: now=1 review=0 long=0 blocked=0 orient=0/);
    assert.match(res.stdout, /First routes by horizon: now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(res.stdout, /First routes by model: fast=CZS-1\/fast pro=none validator=none human=none/);
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
    const menuTxtPath = path.join(dir, '.atris', 'state', 'zero-shot.menu.txt');
    const fastPromptPath = path.join(dir, '.atris', 'state', 'zero-shot.fast.prompt.txt');
    const proPromptPath = path.join(dir, '.atris', 'state', 'zero-shot.pro.prompt.txt');
    const validatorPromptPath = path.join(dir, '.atris', 'state', 'zero-shot.validator.prompt.txt');
    const humanPromptPath = path.join(dir, '.atris', 'state', 'zero-shot.human.prompt.txt');
    const horizonPromptPaths = {
      now: path.join(dir, '.atris', 'state', 'zero-shot.now.prompt.txt'),
      review: path.join(dir, '.atris', 'state', 'zero-shot.review.prompt.txt'),
      long: path.join(dir, '.atris', 'state', 'zero-shot.long.prompt.txt'),
      blocked: path.join(dir, '.atris', 'state', 'zero-shot.blocked.prompt.txt'),
      orient: path.join(dir, '.atris', 'state', 'zero-shot.orient.prompt.txt'),
    };
    assert.equal(packet.durable.wrote, true);
    assert.equal(packet.durable.latest_json, '.atris/state/zero-shot.latest.json');
    assert.equal(packet.durable.prompt_txt, '.atris/state/zero-shot.prompt.txt');
    assert.equal(packet.durable.menu_txt, '.atris/state/zero-shot.menu.txt');
    assert.deepEqual(packet.durable.model_prompt_txt, {
      fast: '.atris/state/zero-shot.fast.prompt.txt',
      pro: '.atris/state/zero-shot.pro.prompt.txt',
      validator: '.atris/state/zero-shot.validator.prompt.txt',
      human: '.atris/state/zero-shot.human.prompt.txt',
    });
    assert.deepEqual(packet.durable.horizon_prompt_txt, {
      now: '.atris/state/zero-shot.now.prompt.txt',
      review: '.atris/state/zero-shot.review.prompt.txt',
      long: '.atris/state/zero-shot.long.prompt.txt',
      blocked: '.atris/state/zero-shot.blocked.prompt.txt',
      orient: '.atris/state/zero-shot.orient.prompt.txt',
    });
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
    assert.equal(fs.existsSync(menuTxtPath), true);
    const menuTxtRealPath = fs.realpathSync(menuTxtPath);
    assert.equal(packet.durable.menu_txt_abs, menuTxtRealPath);
    assert.equal(fs.existsSync(fastPromptPath), true);
    assert.equal(fs.existsSync(proPromptPath), true);
    assert.equal(fs.existsSync(validatorPromptPath), true);
    assert.equal(fs.existsSync(humanPromptPath), true);
    for (const filePath of Object.values(horizonPromptPaths)) assert.equal(fs.existsSync(filePath), true);
    const latest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
    assert.equal(latest.schema, 'atris.zero_shot_next_move.v1');
    assert.equal(latest.generated_at, packet.generated_at);
    assert.equal(latest.handoff.prompt, packet.handoff.prompt);
    assert.equal(latest.durable.source_fingerprint, packet.freshness.source_fingerprint);
    assert.equal(latest.durable.menu_txt, '.atris/state/zero-shot.menu.txt');
    assert.equal(latest.durable.menu_txt_abs, menuTxtRealPath);
    assert.equal(latest.durable.model_prompts.fast.model_tier_match, true);
    assert.equal(latest.durable.model_prompts.fast.selected_ref, 'CZS-1');
    assert.equal(latest.durable.model_prompts.fast.first_command, 'atris task current-step --tag cli --json');
    assert.equal(latest.durable.model_prompts.pro.model_tier_match, false);
    assert.equal(latest.durable.model_prompts.pro.first_command, 'atris radar --json');
    assert.equal(latest.durable.horizon_prompts.now.horizon_match, true);
    assert.equal(latest.durable.horizon_prompts.now.selected_ref, 'CZS-1');
    assert.equal(latest.durable.horizon_prompts.now.first_command, 'atris task current-step --tag cli --json');
    assert.equal(latest.durable.horizon_prompts.long.horizon, 'long_term');
    assert.equal(latest.durable.horizon_prompts.long.horizon_match, false);
    assert.equal(latest.durable.horizon_prompts.long.first_command, 'atris radar --json');
    assert.equal(fs.readFileSync(promptTxtPath, 'utf8'), `${packet.handoff.prompt}\n`);
    const menuText = fs.readFileSync(menuTxtPath, 'utf8');
    assert.match(menuText, /^route menu:/);
    assert.match(menuText, /first by horizon: now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(menuText, /first by model: fast=CZS-1\/fast pro=none validator=none human=none/);
    assert.match(menuText, /1\. now\/fast\/fast_model_task \| CZS-1 - Add zero-shot CLI command/);
    assert.match(menuText, /run: atris task current-step --tag cli --json/);
    assert.match(menuText, /select horizon: atris 0-shot --horizon now\|review\|long\|blocked\|orient --prompt/);
    assert.match(menuText, /select model: atris 0-shot --model fast\|pro\|validator\|human --prompt/);
    assert.match(fs.readFileSync(fastPromptPath, 'utf8'), /Route: fast_model_task/);
    assert.match(fs.readFileSync(fastPromptPath, 'utf8'), /Focus: CZS-1 - Add zero-shot CLI command/);
    assert.match(fs.readFileSync(fastPromptPath, 'utf8'), /Queue: total=1 open=0 claimed=1 review=0 blocked=0 failed=0 done=0/);
    assert.match(fs.readFileSync(fastPromptPath, 'utf8'), /Route inventory: total=1 compact=1 hidden=0 full_field=routes\.all_options/);
    assert.match(fs.readFileSync(fastPromptPath, 'utf8'), /First routes by horizon: now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(fs.readFileSync(fastPromptPath, 'utf8'), /First routes by model: fast=CZS-1\/fast pro=none validator=none human=none/);
    assert.match(fs.readFileSync(proPromptPath, 'utf8'), /No pro model route is available/);
    assert.match(fs.readFileSync(validatorPromptPath, 'utf8'), /No validator model route is available/);
    assert.match(fs.readFileSync(humanPromptPath, 'utf8'), /No human model route is available/);
    assert.match(fs.readFileSync(horizonPromptPaths.now, 'utf8'), /Route: fast_model_task/);
    assert.match(fs.readFileSync(horizonPromptPaths.now, 'utf8'), /Model buckets: fast=1 pro=0 validator=0 human=0/);
    assert.match(fs.readFileSync(horizonPromptPaths.long, 'utf8'), /No long_term horizon route is available/);
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
    assert.equal(fresh.prompt_fresh, true);
    assert.equal(typeof fresh.prompt_actual_sha1, 'string');
    assert.equal(fresh.prompt_actual_sha1, fresh.prompt_expected_sha1);
    assert.equal(fresh.menu_exists, true);
    assert.equal(fresh.menu_fresh, true);
    assert.equal(typeof fresh.menu_actual_sha1, 'string');
    assert.equal(fresh.menu_actual_sha1, fresh.menu_expected_sha1);
    assert.equal(fresh.model_prompts_fresh, true);
    assert.equal(fresh.model_prompts.fast.exists, true);
    assert.equal(fresh.model_prompts.fast.matches_expected, true);
    assert.equal(fresh.model_prompts.fast.actual_sha1, fresh.model_prompts.fast.expected_sha1);
    assert.equal(fresh.model_prompts.pro.exists, true);
    assert.equal(fresh.model_prompts.pro.matches_expected, true);
    assert.equal(fresh.horizon_prompts_fresh, true);
    assert.equal(fresh.horizon_prompts.now.exists, true);
    assert.equal(fresh.horizon_prompts.now.matches_expected, true);
    assert.equal(fresh.horizon_prompts.now.actual_sha1, fresh.horizon_prompts.now.expected_sha1);
    assert.equal(fresh.horizon_prompts.long.exists, true);
    assert.equal(fresh.horizon_prompts.long.matches_expected, true);
    assert.equal(fresh.latest_selected_ref, 'CZS-1');
    assert.equal(fresh.current_selected_ref, 'CZS-1');
    assert.equal(fresh.latest_source_fingerprint, fresh.current_source_fingerprint);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'zero-shot.menu.txt'), 'stale route menu\n', 'utf8');
    const staleMenuRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(staleMenuRes.status, 1, staleMenuRes.stderr || staleMenuRes.stdout);
    const staleMenu = JSON.parse(staleMenuRes.stdout);
    assert.equal(staleMenu.status, 'stale');
    assert.equal(staleMenu.ok, false);
    assert.equal(staleMenu.menu_exists, true);
    assert.equal(staleMenu.menu_fresh, false);
    assert.notEqual(staleMenu.menu_actual_sha1, staleMenu.menu_expected_sha1);

    const rewriteAfterMenuDrift = runCli(['zero-shot', '--write'], { cwd: dir });
    assert.equal(rewriteAfterMenuDrift.status, 0, rewriteAfterMenuDrift.stderr || rewriteAfterMenuDrift.stdout);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt'), 'stale global prompt\n', 'utf8');
    const staleGlobalPromptRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(staleGlobalPromptRes.status, 1, staleGlobalPromptRes.stderr || staleGlobalPromptRes.stdout);
    const staleGlobalPrompt = JSON.parse(staleGlobalPromptRes.stdout);
    assert.equal(staleGlobalPrompt.status, 'stale');
    assert.equal(staleGlobalPrompt.ok, false);
    assert.equal(staleGlobalPrompt.prompt_exists, true);
    assert.equal(staleGlobalPrompt.prompt_fresh, false);
    assert.equal(staleGlobalPrompt.menu_fresh, true);
    assert.notEqual(staleGlobalPrompt.prompt_actual_sha1, staleGlobalPrompt.prompt_expected_sha1);

    const rewriteAfterGlobalDrift = runCli(['zero-shot', '--write'], { cwd: dir });
    assert.equal(rewriteAfterGlobalDrift.status, 0, rewriteAfterGlobalDrift.stderr || rewriteAfterGlobalDrift.stdout);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'zero-shot.pro.prompt.txt'), 'stale pro prompt\n', 'utf8');
    const staleModelPromptRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(staleModelPromptRes.status, 1, staleModelPromptRes.stderr || staleModelPromptRes.stdout);
    const staleModelPrompt = JSON.parse(staleModelPromptRes.stdout);
    assert.equal(staleModelPrompt.status, 'stale');
    assert.equal(staleModelPrompt.ok, false);
    assert.equal(staleModelPrompt.prompt_fresh, true);
    assert.equal(staleModelPrompt.menu_fresh, true);
    assert.equal(staleModelPrompt.model_prompts_fresh, false);
    assert.equal(staleModelPrompt.model_prompts.pro.exists, true);
    assert.equal(staleModelPrompt.model_prompts.pro.matches_expected, false);
    assert.notEqual(staleModelPrompt.model_prompts.pro.actual_sha1, staleModelPrompt.model_prompts.pro.expected_sha1);

    const rewriteAfterModelDrift = runCli(['zero-shot', '--write'], { cwd: dir });
    assert.equal(rewriteAfterModelDrift.status, 0, rewriteAfterModelDrift.stderr || rewriteAfterModelDrift.stdout);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'zero-shot.long.prompt.txt'), 'stale long prompt\n', 'utf8');
    const staleHorizonPromptRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(staleHorizonPromptRes.status, 1, staleHorizonPromptRes.stderr || staleHorizonPromptRes.stdout);
    const staleHorizonPrompt = JSON.parse(staleHorizonPromptRes.stdout);
    assert.equal(staleHorizonPrompt.status, 'stale');
    assert.equal(staleHorizonPrompt.ok, false);
    assert.equal(staleHorizonPrompt.prompt_fresh, true);
    assert.equal(staleHorizonPrompt.menu_fresh, true);
    assert.equal(staleHorizonPrompt.model_prompts_fresh, true);
    assert.equal(staleHorizonPrompt.horizon_prompts_fresh, false);
    assert.equal(staleHorizonPrompt.horizon_prompts.long.exists, true);
    assert.equal(staleHorizonPrompt.horizon_prompts.long.matches_expected, false);
    assert.notEqual(staleHorizonPrompt.horizon_prompts.long.actual_sha1, staleHorizonPrompt.horizon_prompts.long.expected_sha1);

    const rewriteAfterHorizonDrift = runCli(['zero-shot', '--write'], { cwd: dir });
    assert.equal(rewriteAfterHorizonDrift.status, 0, rewriteAfterHorizonDrift.stderr || rewriteAfterHorizonDrift.stdout);

    fs.rmSync(path.join(dir, '.atris', 'state', 'zero-shot.fast.prompt.txt'));
    const missingModelPromptRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(missingModelPromptRes.status, 1, missingModelPromptRes.stderr || missingModelPromptRes.stdout);
    const missingModelPrompt = JSON.parse(missingModelPromptRes.stdout);
    assert.equal(missingModelPrompt.status, 'stale');
    assert.equal(missingModelPrompt.ok, false);
    assert.equal(missingModelPrompt.model_prompts_fresh, false);
    assert.equal(missingModelPrompt.model_prompts.fast.exists, false);
    assert.equal(missingModelPrompt.model_prompts.fast.matches_expected, false);

    const rewrite = runCli(['zero-shot', '--write'], { cwd: dir });
    assert.equal(rewrite.status, 0, rewrite.stderr || rewrite.stdout);

    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        { display_id: 'REV-1', title: 'Review the new proof', status: 'review', tag: 'cli' },
      ],
    }, null, 2));

    const staleRes = runCli(['zero-shot', '--check', '--json'], { cwd: dir });
    assert.equal(staleRes.status, 1, staleRes.stderr || staleRes.stdout);
    const stale = JSON.parse(staleRes.stdout);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.ok, false);
    assert.equal(stale.latest_selected_ref, 'CZS-1');
    assert.equal(stale.current_selected_ref, 'REV-1');
    assert.notEqual(stale.latest_source_fingerprint, stale.current_source_fingerprint);
    assert.equal(stale.refresh_command, 'atris 0-shot --write');
    assert.equal(stale.legacy_refresh_command, 'atris zero-shot --write');

    const text = runCli(['zero-shot', '--check'], { cwd: dir });
    assert.equal(text.status, 1, text.stderr || text.stdout);
    assert.match(text.stdout, /0-shot latest check/);
    assert.match(text.stdout, /status: stale/);
    assert.match(text.stdout, /prompt: stale/);
    assert.match(text.stdout, /menu: stale/);
    assert.match(text.stdout, /model prompts: stale_or_missing/);
    assert.match(text.stdout, /horizon prompts: stale_or_missing/);
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
    assert.equal(res.status, 1, res.stderr || res.stdout);
    const check = JSON.parse(res.stdout);
    assert.equal(check.status, 'missing');
    assert.equal(check.ok, false);
    assert.equal(check.latest_exists, false);
    assert.equal(check.prompt_exists, false);
    assert.equal(check.menu_exists, false);
    assert.equal(check.menu_fresh, false);
    assert.equal(check.current_selected_ref, 'CZS-1');
    assert.equal(check.refresh_command, 'atris 0-shot --write');

    const nextRes = runCli(['next', '--check', '--json'], { cwd: dir });
    assert.equal(nextRes.status, 1, nextRes.stderr || nextRes.stdout);
    const nextCheck = JSON.parse(nextRes.stdout);
    assert.equal(nextCheck.status, 'missing');
    assert.equal(nextCheck.ok, false);
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
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.menu.txt')), true);
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
    assert.equal(packet.decision.owner_action, 'owner-only: clear the approval or blocker for OWN-2');
    assert.match(packet.decision.safe_agent_action, /read-only: atris task page OWN-2 --json/);
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
    assert.deepEqual(packet.routes.horizons, {
      now: 2,
      immediate_review: 0,
      long_term: 1,
      blocked: 1,
      orient: 0,
    });
    assert.equal(packet.routes.horizon_first.now.ref, 'FAIL-1');
    assert.equal(packet.routes.horizon_first.long_term.ref, 'ARC-1');
    assert.equal(packet.routes.horizon_first.blocked.ref, 'OWN-2');
    assert.equal(packet.routes.horizon_first.immediate_review, null);
    assert.equal(packet.routes.models.human.count, 1);
    assert.equal(packet.routes.models.human.first.ref, 'OWN-2');
    assert.equal(packet.routes.models.human.first.first_command, 'atris task page OWN-2 --json');
    assert.equal(packet.routes.models.human.first.owner_action, 'owner-only: clear the approval or blocker for OWN-2');
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
    assert.deepEqual(packet.routes.all_options.map(route => [route.ref, route.lane, route.model_tier, route.first_command]), [
      ['OWN-2', 'owner_gate', 'human', 'atris task page OWN-2 --json'],
      ['FAIL-1', 'recovery_lane', 'pro', 'atris task page FAIL-1 --json'],
      ['FAST-1', 'fast_model_task', 'fast', 'atris task current-step --tag cli --json'],
      ['ARC-1', 'long_horizon', 'pro', 'atris task page ARC-1 --json'],
    ]);
    assert.match(packet.routes.options[0].prompt, /Route: owner_gate/);
    assert.match(packet.routes.options[1].prompt, /Run first: atris task page FAIL-1 --json/);
    assert.equal(packet.handoff.prompt.startsWith(packet.routes.options[0].prompt), true);
    assert.match(packet.handoff.prompt, /Owner action: owner-only: clear the approval or blocker for OWN-2/);
    assert.match(packet.handoff.prompt, /Agent-safe action: read-only: atris task page OWN-2 --json/);
    assert.match(packet.handoff.prompt, /Route inventory: total=4 compact=4 hidden=0 full_field=routes\.all_options/);
    assert.match(packet.handoff.prompt, /Queue: total=4 open=0 claimed=3 review=0 blocked=0 failed=1 done=0/);
    assert.match(packet.handoff.prompt, /First routes by horizon: now=FAIL-1\/pro review=none long=ARC-1\/pro blocked=OWN-2\/human orient=none/);
    assert.match(packet.handoff.prompt, /Model buckets: fast=1 pro=2 validator=0 human=1/);
    assert.match(packet.handoff.prompt, /First routes by model: fast=FAST-1\/fast pro=FAIL-1\/pro validator=none human=OWN-2\/human/);
    assert.equal(packet.handoff.route_options_field, 'routes.all_options');
    assert.equal(packet.commands.zero_shot_all, 'atris 0-shot --all');
    assert.equal(Object.prototype.hasOwnProperty.call(packet.routes.options[0], 'source'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.routes.all_options[0], 'source'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(packet.routes.models.human.first, 'source'), false);

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

    const longRes = runCli(['0-shot', '--model', 'pro', '--horizon', 'long', '--json'], { cwd: dir });
    assert.equal(longRes.status, 0, longRes.stderr || longRes.stdout);
    const longPacket = JSON.parse(longRes.stdout);
    assert.equal(longPacket.decision.requested_model_tier, 'pro');
    assert.equal(longPacket.decision.requested_horizon, 'long_term');
    assert.equal(longPacket.decision.model_tier_match, true);
    assert.equal(longPacket.decision.horizon_match, true);
    assert.equal(longPacket.decision.selected_ref, 'ARC-1');
    assert.equal(longPacket.decision.lane, 'long_horizon');
    assert.equal(longPacket.commands.first_command, 'atris task page ARC-1 --json');
    assert.equal(longPacket.routes.requested_horizon, 'long_term');
    assert.equal(longPacket.routes.horizon_match, true);

    const missingFastLongRes = runCli(['0-shot', '--model', 'fast', '--horizon', 'long', '--json'], { cwd: dir });
    assert.equal(missingFastLongRes.status, 0, missingFastLongRes.stderr || missingFastLongRes.stdout);
    const missingFastLongPacket = JSON.parse(missingFastLongRes.stdout);
    assert.equal(missingFastLongPacket.decision.requested_model_tier, 'fast');
    assert.equal(missingFastLongPacket.decision.requested_horizon, 'long_term');
    assert.equal(missingFastLongPacket.decision.model_tier_match, false);
    assert.equal(missingFastLongPacket.decision.horizon_match, false);
    assert.equal(missingFastLongPacket.decision.selected_ref, null);
    assert.equal(missingFastLongPacket.commands.first_command, 'atris radar --json');
    assert.match(missingFastLongPacket.handoff.prompt, /No fast model route in long_term horizon is available/);

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

test('zero-shot exposes complete route inventory beyond the visible limit', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, overflowRouteTasks());

    const jsonRes = runCli(['zero-shot', '--json'], { cwd: dir });
    assert.equal(jsonRes.status, 0, jsonRes.stderr || jsonRes.stdout);
    const packet = JSON.parse(jsonRes.stdout);
    assert.equal(packet.routes.total, 10);
    assert.equal(packet.routes.shown, 8);
    assert.equal(packet.routes.visible_limit, 8);
    assert.equal(packet.routes.hidden_count, 2);
    assert.equal(packet.routes.options.length, 8);
    assert.equal(packet.routes.all_options.length, 10);
    assert.equal(packet.routes.options.some(route => route.ref === 'ARC-9'), false);
    assert.equal(packet.routes.all_options.some(route => route.ref === 'ARC-9'), true);
    assert.equal(packet.routes.horizon_first.long_term.ref, 'ARC-9');
    assert.equal(packet.routes.all_options.every(route => !Object.prototype.hasOwnProperty.call(route, 'source')), true);
    assert.match(packet.routes.all_options[9].prompt, /Run first: atris task page ARC-9 --json/);

    const allRes = runCli(['0-shot', '--all'], { cwd: dir });
    assert.equal(allRes.status, 0, allRes.stderr || allRes.stdout);
    assert.match(allRes.stdout, /first by horizon: now=FAST-1\/fast review=none long=ARC-9\/pro blocked=none orient=none/);
    assert.match(allRes.stdout, /first by model: fast=FAST-1\/fast pro=ARC-9\/pro validator=none human=none/);
    assert.match(allRes.stdout, /9\. now\/fast\/fast_model_task \| FAST-10 - Fix CLI help copy 10/);
    assert.match(allRes.stdout, /10\. long_term\/pro\/long_horizon \| ARC-9 - Plan architecture migration roadmap/);
    assert.doesNotMatch(allRes.stdout, /more not shown/);

    const writeRes = runCli(['zero-shot', '--write', '--json'], { cwd: dir });
    assert.equal(writeRes.status, 0, writeRes.stderr || writeRes.stdout);
    const written = JSON.parse(writeRes.stdout);
    assert.equal(written.durable.horizon_prompts.long.horizon_match, true);
    assert.equal(written.durable.horizon_prompts.long.selected_ref, 'ARC-9');
    const longPrompt = fs.readFileSync(path.join(dir, '.atris', 'state', 'zero-shot.long.prompt.txt'), 'utf8');
    assert.match(longPrompt, /Route: long_horizon/);
    assert.match(longPrompt, /Focus: ARC-9 - Plan architecture migration roadmap/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot human output summarizes work by horizon and model tier', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'FAST-1', title: 'Fix CLI help copy', status: 'claimed', tag: 'cli' },
      { display_id: 'ARC-1', title: 'Plan architecture migration roadmap', status: 'claimed', tag: 'architecture' },
      { display_id: 'OWN-2', title: 'Publish release after human approval', status: 'claimed', tag: 'release' },
      { display_id: 'FAIL-1', title: 'Fix failing release gate', status: 'failed', tag: 'release' },
    ]);

    const res = runCli(['zero-shot'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /routes: OWN-2:owner_gate\/human, FAIL-1:recovery_lane\/pro, FAST-1:fast_model_task\/fast/);
    assert.match(res.stdout, /horizons: now=2 immediate_review=0 long_term=1 blocked=1 orient=0/);
    assert.match(res.stdout, /models: fast=1 pro=2 validator=0 human=1/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('zero-shot --all prints a readable route menu without writing state', () => {
  const dir = makeTempDir();
  try {
    seedWorkspace(dir, [
      { display_id: 'FAST-1', title: 'Fix CLI help copy', status: 'claimed', tag: 'cli' },
      { display_id: 'ARC-1', title: 'Plan architecture migration roadmap', status: 'claimed', tag: 'architecture' },
      { display_id: 'OWN-2', title: 'Publish release after human approval', status: 'claimed', tag: 'release' },
      { display_id: 'FAIL-1', title: 'Fix failing release gate', status: 'failed', tag: 'release' },
    ]);

    const res = runCli(['0-shot', '--all'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /0-shot next move/);
    assert.match(res.stdout, /route menu:/);
    assert.match(res.stdout, /1\. blocked\/human\/owner_gate \| OWN-2 - Publish release after human approval/);
    assert.match(res.stdout, /run: atris task page OWN-2 --json/);
    assert.match(res.stdout, /owner: owner-only: clear the approval or blocker for OWN-2/);
    assert.match(res.stdout, /agent-safe: read-only: atris task page OWN-2 --json/);
    assert.match(res.stdout, /2\. now\/pro\/recovery_lane \| FAIL-1 - Fix failing release gate/);
    assert.match(res.stdout, /3\. now\/fast\/fast_model_task \| FAST-1 - Fix CLI help copy/);
    assert.match(res.stdout, /4\. long_term\/pro\/long_horizon \| ARC-1 - Plan architecture migration roadmap/);
    assert.match(res.stdout, /select horizon: atris 0-shot --horizon now\|review\|long\|blocked\|orient --prompt/);
    assert.match(res.stdout, /select model: atris 0-shot --model fast\|pro\|validator\|human --prompt/);
    assert.match(res.stdout, /all: atris 0-shot --all/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), false);
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
    assert.match(res.stdout, /--horizon now\|review\|long\|blocked\|orient selects/);
    assert.match(res.stdout, /first_command/);
    assert.match(res.stdout, /routes\.options/);
    assert.match(res.stdout, /routes\.all_options/);
    assert.match(res.stdout, /routes\.models/);
    assert.match(res.stdout, /handoff\.prompt/);
    assert.match(res.stdout, /--prompt prints only/);
    assert.match(res.stdout, /--all prints the selected route plus the full route menu/);
    assert.match(res.stdout, /--write refreshes \.atris\/state\/zero-shot\.latest\.json/);
    assert.match(res.stdout, /\.atris\/state\/zero-shot\.menu\.txt/);
    assert.match(res.stdout, /--check compares the durable latest packet, global prompt, route menu, per-model prompts, per-horizon prompts, and current source fingerprints, then exits 0 only when fresh/);
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
    assert.match(res.stdout, /If you are unsure, run "atris 0-shot --all"/);
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
    assert.match(res.stdout, /queue total=1 open=0 claimed=1 review=0 blocked=0 failed=0 done=0/);
    assert.match(res.stdout, /routes total=1 hidden=0 \| horizons now=1 review=0 long=0 blocked=0 orient=0 \| models fast=1 pro=0 validator=0 human=0/);
    assert.match(res.stdout, /model first fast=CZS-1\/fast pro=none validator=none human=none/);
    assert.match(res.stdout, /horizon first now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(res.stdout, /0-shot durable: status=fresh prompt=fresh menu=fresh model=fresh horizon=fresh \| files: \.atris\/state\/zero-shot\.menu\.txt, \.atris\/state\/zero-shot\.prompt\.txt \| check: atris 0-shot --check/);
    assert.match(res.stdout, /Next: run first: atris task current-step --tag cli --json/);
    assert.match(res.stdout, /Routes: atris 0-shot --all \| prompt: atris 0-shot --prompt \| model: atris 0-shot --model <tier> --prompt \| horizon: atris 0-shot --horizon <horizon> --prompt/);
    assert.doesNotMatch(res.stdout, /Next: atris 0-shot --all/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.menu.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.fast.prompt.txt')), true);
    const latest = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json'), 'utf8'));
    assert.equal(latest.durable.wrote, true);
    assert.equal(latest.decision.selected_ref, 'CZS-1');
  } finally {
    cleanupTempDir(dir);
  }
});

test('activate surfaces zero-shot owner-gate context', () => {
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
          human_accept: { command: 'atris task accept CZS-1' },
        },
      },
    ]);

    const res = runCli(['activate'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /0-shot: owner_gate -> atris task page CZS-1 --json \| prompt: atris 0-shot --prompt/);
    assert.match(res.stdout, /owner human-only: atris task accept CZS-1/);
    assert.match(res.stdout, /agent-safe read-only: atris task page CZS-1 --json; then wait or pick a non-blocked route from atris 0-shot --all/);
    assert.match(res.stdout, /queue total=1 open=0 claimed=0 review=1 blocked=0 failed=0 done=0/);
    assert.match(res.stdout, /horizon first now=none review=none long=none blocked=CZS-1\/human orient=none/);
    assert.match(res.stdout, /Next: run first: atris task page CZS-1 --json/);
    assert.match(res.stdout, /Boundary: read-only first command; stop at owner gate; human accept is human-only\./);
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
    assert.match(res.stdout, /queue total=0 open=0 claimed=0 review=0 blocked=0 failed=0 done=0/);
    assert.match(res.stdout, /routes total=0 hidden=0 \| horizons now=0 review=0 long=0 blocked=0 orient=0 \| models fast=0 pro=0 validator=0 human=0/);
    assert.match(res.stdout, /model first fast=none pro=none validator=none human=none/);
    assert.match(res.stdout, /horizon first now=none review=none long=none blocked=none orient=none/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.menu.txt')), true);
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
    assert.match(res.stdout, /queue total=1 open=0 claimed=1 review=0 blocked=0 failed=0 done=0/);
    assert.match(res.stdout, /routes total=1 hidden=0 \| horizons now=1 review=0 long=0 blocked=0 orient=0 \| models fast=1 pro=0 validator=0 human=0/);
    assert.match(res.stdout, /model first fast=CZS-1\/fast pro=none validator=none human=none/);
    assert.match(res.stdout, /horizon first now=CZS-1\/fast review=none long=none blocked=none orient=none/);
    assert.match(res.stdout, /Ready\. Run 'atris 0-shot --all' to inspect the route menu, or 'atris 0-shot --prompt' for a copy-paste handoff\./);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.prompt.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.menu.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'zero-shot.fast.prompt.txt')), true);
    const latest = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'zero-shot.latest.json'), 'utf8'));
    assert.equal(latest.decision.selected_ref, 'CZS-1');
  } finally {
    cleanupTempDir(dir);
  }
});
