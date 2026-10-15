const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  taskStore,
  ensureWikiScaffold,
  normalizeWikiOnlyPrefix,
  validateAgentReadableWikiPages,
  analyzeBusinessDoctor,
  businessMatchesSlug,
  collectBusinessShareState,
  createCanonicalBusinessWorkspace,
  onboardBusiness,
  renderBusinessCreatedNextSteps,
  shareBusinessWorkspace,
  recordBusinessRun,
  getScorecardsPath,
  readScorecards,
  computeTickReward,
  verifyJudgeIntegrity,
  getVerifyCommand,
  getRecentSignals,
  maybeWriteCompletedEndgameScorecard,
  renderHumanSuggestion,
  renderHumanTickIntro,
  scoreEndgameCandidates,
  suggestNextTask,
  writeLesson,
  REWARD_CONFIG,
  REWARD_CHECKSUM,
  repoRoot,
  makeTempDir,
  cleanupTempDir,
  seedBusinessOsState,
  runCli,
  hasNodeSqlite,
  runGit,
  initWorkspace,
  writeLiveMission,
  writeTodayLog,
} = require('./helpers/commands-shared');

test('task sync dry-run maps local tasks to canonical cloud task writes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz-task-sync',
      slug: 'task-sync-lab',
    }), 'utf8');

    const created = runCli(['task', 'new', 'Sync local task to cloud control plane', '--tag', 'swarlo', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const noted = runCli(['task', 'say', id, 'Use dry-run before cloud writes', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(noted.status, 0, noted.stderr);

    const ready = runCli(['task', 'ready', id, '--proof', 'dry-run sync validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const sync = runCli(['task', 'sync', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(sync.status, 0, sync.stderr);
    const payload = JSON.parse(sync.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.business_id, 'biz-task-sync');
    assert.equal(payload.planned_writes, 1);
    assert.equal(payload.plan[0].method, 'POST');
    assert.equal(payload.plan[0].endpoint, '/business/biz-task-sync/work/tasks');
    assert.equal(payload.plan[0].body.type, 'improvement');
    assert.equal(payload.plan[0].body.owner_member_id, 'agent:codex');
    assert.equal(payload.plan[0].body.metadata.source, 'atris_cli_task');
    assert.equal(payload.plan[0].body.metadata.local_task_id, id);
    assert.equal(payload.plan[0].body.metadata.approval_status, 'pending');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_owner, 'codex');
    assert.equal(payload.plan[0].body.metadata.swarlo.lease_state, 'none');
    assert.equal(payload.plan[0].body.needs_approval, true);
    assert.equal(payload.plan[0].after_create[0].body.state, 'doing');
    assert.match(payload.plan[0].body.description, /Use dry-run before cloud writes/);
    assert.match(payload.plan[0].body.description, /Proof: dry-run sync validation passed/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task projection exposes goals, review proof, and task lineage for visual boards', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '---',
      'type: goals',
      '---',
      '',
      '# Goals',
      '',
      '- Build the task factory into a compounding autonomous development surface',
      '- Connect tasks to Swarlo and Supabase',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Improve task factory lineage view', '--tag', 'tasks', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const unrelated = runCli(['task', 'new', 'Repair notarized Mac installer', '--tag', 'release', '--json'], { cwd: dir, env });
    assert.equal(unrelated.status, 0, unrelated.stderr);
    const unrelatedId = JSON.parse(unrelated.stdout).task_id;

    const genericLoop = runCli(['task', 'new', 'Loop tick: Validate local Claude /goal behavior', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(genericLoop.status, 0, genericLoop.stderr);
    const genericLoopId = JSON.parse(genericLoop.stdout).task_id;

    const finished = runCli([
      'task', 'finish', id,
      '--proof', 'board lineage validation passed',
      '--lesson', 'Visual tasks need goal and proof context',
      '--next', 'Render lineage in Task Factory board',
      '--create-next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finished.status, 0, finished.stderr);
    const donePayload = JSON.parse(finished.stdout);
    const nextId = donePayload.next_task_id;

    const exported = runCli(['task', 'export', '--json'], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(exported.stdout).projection;
    assert.equal(projection.goals.items[0], 'Build the task factory into a compounding autonomous development surface');
    assert.ok(projection.streams.some(stream => stream.objective === 'Build the task factory into a compounding autonomous development surface'));
    const parent = projection.tasks.find(t => t.id === id);
    const child = projection.tasks.find(t => t.id === nextId);
    const unrelatedTask = projection.tasks.find(t => t.id === unrelatedId);
    const genericLoopTask = projection.tasks.find(t => t.id === genericLoopId);
    assert.equal(parent.objective, 'Build the task factory into a compounding autonomous development surface');
    assert.equal(unrelatedTask.objective, null);
    assert.equal(genericLoopTask.objective, null);
    assert.equal(parent.review.summary, 'Completed result for improve task factory lineage view.');
    assert.equal(parent.review.proof, 'board lineage validation passed');
    assert.equal(parent.review.lesson, 'Visual tasks need goal and proof context');
    assert.deepEqual(parent.lineage.child_task_ids, [nextId]);
    assert.equal(parent.lineage.next_task_suggestion, 'Render lineage in Task Factory board');
    assert.equal(child.lineage.parent_task_id, id);
    assert.equal(child.lineage.parent_title, 'Improve task factory lineage view');
    const stream = projection.streams.find(s => s.objective === parent.objective);
    assert.equal(stream.done_count, 1);
    assert.equal(stream.active_count, 1);
    assert.ok(stream.tasks.some(t => t.id === nextId && t.parent_task_id === id));
  } finally {
    cleanupTempDir(dir);
  }
});


test('TODO fallback parser handles nested groups and modern task ids', () => {
  const dir = makeTempDir();
  try {
    const todoPath = path.join(dir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '### UX',
      '- [ ] **Fast idea dump** — capture rough thoughts before running agents.',
      '- **windows-public-release-T1:** Publish signed Windows installer [agent] [execute]',
      '  **Verify:** npm run release:gate:win',
      '',
      '## In Progress',
      '',
      '- **prod-first-install-hotfix-T1:** Fix first-install failures [agent] [execute]',
      '  **Claimed by:** Codex at 2026-05-02T12:34:00Z',
      '  **Verify:** npm run update:smoke',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const { parseTodoFile } = require('../lib/todo-fallback');
    const parsed = parseTodoFile(todoPath);
    assert.equal(parsed.backlog.length, 2);
    assert.equal(parsed.backlog[0].title, 'Fast idea dump - capture rough thoughts before running agents.');
    assert.equal(parsed.backlog[1].id, 'windows-public-release-T1');
    assert.equal(parsed.backlog[1].verify, 'npm run release:gate:win');
    assert.equal(parsed.inProgress[0].id, 'prod-first-install-hotfix-T1');
    assert.equal(parsed.inProgress[0].claimed, 'Codex at 2026-05-02T12:34:00Z');
    assert.equal(parsed.inProgress[0].verify, 'npm run update:smoke');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task import preserves Verify metadata through DB-backed TODO shim', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    const todoPath = path.join(atrisDir, 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Task plane import keeps proof [endgame] [execute]',
      '  **Verify:** test -f done.txt',
      '',
      '## In Progress',
      '',
      '- **T2:** Claimed task keeps section [execute]',
      '  **Claimed by:** codex at 2026-04-28T07:29:42Z',
      '  **Verify:** test -f claimed.txt',
      '',
      '## Completed',
      '',
    ].join('\n'), 'utf8');

    const imported = runCli(['task', 'import', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /imported 2 new, skipped 0/);

    const script = [
      "const { parseTodo } = require('./lib/todo');",
      "const { getVerifyCommand } = require('./commands/autopilot');",
      `const todo = parseTodo(${JSON.stringify(todoPath)});`,
      `const verify = getVerifyCommand(${JSON.stringify(dir)}, 'Task plane import keeps proof');`,
      "console.log(JSON.stringify({ todo, verify }));",
    ].join('\n');
    const parsed = spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        ATRIS_TASK_DB: '1',
        ATRIS_TASKS_DB: dbPath,
        NODE_NO_WARNINGS: '1',
      },
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const out = JSON.parse(parsed.stdout);
    assert.equal(out.todo.backlog[0].verify, 'test -f done.txt');
    assert.equal(out.todo.inProgress[0].verify, 'test -f claimed.txt');
    assert.equal(out.todo.inProgress[0].claimed, 'codex at 2026-04-28T07:29:42Z');
    assert.deepEqual(out.verify, { cmd: 'test -f done.txt', explicit: true });
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// search
// ============================================

test('search with no keyword prints usage', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['search'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Usage: atris search/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search help flags print usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const flag of ['--help', '-h']) {
      const res = runCli(['search', flag], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `search ${flag}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris search <keyword>/);
      assert.doesNotMatch(res.stdout, /No atris\/logs\/ directory found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `search ${flag} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `search ${flag} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('search with zero hits outside a workspace points newcomers to init', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['search', 'credits'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    // outside a workspace the hint is the whole output; empty scan rows are noise
    assert.match(res.stdout, /No atris folder here\. Run atris init to set one up\./);
    assert.doesNotMatch(res.stdout, /Feature: none/);
    assert.doesNotMatch(res.stdout, /No matches found\./);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search walks features team wiki then journal in compact mode', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'features', 'credits'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'treasury'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'features', 'credits', 'idea.md'), 'Credits feature spec\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'treasury', 'MEMBER.md'), 'Owns credits and billing.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'credits.md'), 'Credits decisions live here.\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-04.md'), 'older credits note\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-05.md'), 'newer credits note\n', 'utf8');

    const res = runCli(['search', 'credits'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Feature: atris\/features\/credits\//);
    assert.match(res.stdout, /Owner: atris\/team\/treasury\/MEMBER\.md/);
    assert.match(res.stdout, /Wiki: atris\/wiki\/credits\.md/);
    assert.match(res.stdout, /Journal:\n- atris\/logs\/2026\/2026-07-05\.md:1: newer credits note/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search raw prints full file line dump', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'features', 'credits'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'logs', '2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'features', 'credits', 'idea.md'), 'Credits feature spec\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'logs', '2026', '2026-07-05.md'), [
      'newer credits note',
      'another credits note',
    ].join('\n'), 'utf8');

    const res = runCli(['search', 'credits', '--raw'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Searching for "credits" in source, atris\/MAP\.md, atris\/features, atris\/team, atris\/wiki, atris\/logs/);
    assert.match(res.stdout, /atris\/features\/credits\/idea\.md:1\n  Credits feature spec/);
    assert.match(res.stdout, /atris\/logs\/2026\/2026-07-05\.md:1\n  newer credits note/);
    assert.match(res.stdout, /atris\/logs\/2026\/2026-07-05\.md:2\n  another credits note/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('learn help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['learn', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `learn ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris learn \[command\]/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `learn ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `learn ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('soul help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['soul', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `soul ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /atris soul/);
      assert.doesNotMatch(res.stderr, /No atris\/ folder found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `soul ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `soul ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('top-level help shows local and global first-run commands', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /already won\. one next step/);
    assert.match(res.stdout, /atris later "/);
    assert.match(res.stdout, /atris do\b/);
    assert.match(res.stdout, /Keep working/);
    assert.match(res.stdout, /help --all/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('fresh workspace prompt gives one primary first command plus local fallback', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli([], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /is empty/);
    assert.match(res.stdout, /^next: atris "what do you want here\?"$/m);
    assert.doesNotMatch(res.stdout, /atris init --minimal/);
    assert.ok(res.stdout.trim().split('\n').filter(Boolean).length <= 6);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('workspace-free help smoke sweep covers common entrypoints', () => {
  const cases = [
    ['--help'],
    ['status', '--help'],
    ['analytics', '--help'],
    ['brain', '--help'],
    ['brain', '-h'],
    ['brainstorm', '--help'],
    ['brainstorm', '-h'],
    ['brainstorm', 'help'],
    ['fast', '--help'],
    ['ax', 'fast', '--help'],
    ['search', '--help'],
    ['search', '-h'],
    ['learn', '--help'],
    ['learn', '-h'],
    ['learn', 'help'],
    ['soul', '--help'],
    ['soul', '-h'],
    ['soul', 'help'],
    ['activate', '--help'],
    ['launchpad', '--help'],
    ['next', '--help'],
    ['now', '--help'],
    ['radar', '--help'],
    ['ctop', '--help'],
    ['clean', '--help'],
    ['verify', '--help'],
    ['loop', '--help'],
    ['pulse', '--help'],
    ['serve', '--help'],
    ['agent', '--help'],
    ['update', '--help'],
    ['sync', '--help'],
    ['upgrade', '--help'],
    ['release', '--help'],
    ['login', '--help'],
    ['logout', '--help'],
    ['whoami', '--help'],
    ['switch', '--help'],
    ['use', '--help'],
    ['accounts', '--help'],
    ['balance', '--help'],
    ['usage', '--help'],
    ['api-key', '--help'],
    ['topup', '--help'],
    ['buy', '--help'],
    ['transactions', '--help'],
    ['integrations', '--help'],
    ['skill', '--help'],
    ['member', '--help'],
    ['business', 'init', '--help'],
    ['business', 'create', '--help'],
    ['plugin', '--help'],
    ['experiments', '--help'],
    ['receipt', '--help'],
    ['proof', '--help'],
    ['play', '--help'],
    ['code-review', '--help'],
    ['cr', '--help'],
  ];

  for (const args of cases) {
    const dir = makeTempDir();
    try {
      const home = path.join(dir, 'home');
      const res = runCli(args, { cwd: dir, env: { HOME: home } });
      const label = args.join(' ');
      assert.equal(res.status, 0, `${label}: ${res.stderr || res.stdout}`);
      assert.ok((res.stdout + res.stderr).trim().length > 0, `${label} printed no help`);
      assert.doesNotMatch(res.stdout + res.stderr, /folder not found|Run "atris init"|Not logged in|Checking for updates|Current Status|Atris Analytics|CONTEXT LOADED|Wiki Loop/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${label} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${label} created ~/.atris`);
    } finally {
      cleanupTempDir(dir);
    }
  }
});


test('launchpad --json picks the current actor claimed task first', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), [
      '# Atris Brain Status',
      '',
      '## Next Move',
      '',
      'Pick the highest-leverage open TODO item.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      surface: { hidden_done_count: 7 },
      tasks: [
        {
          id: 'task-codex',
          display_id: 'CLI-9',
          title: 'Ship launchpad',
          status: 'claimed',
          claimed_by: 'codex',
          updated_at: 30,
          metadata: {},
        },
        {
          id: 'task-review',
          display_id: 'CLI-8',
          title: 'Check finished work',
          status: 'review',
          claimed_by: 'claude',
          updated_at: 20,
          metadata: { agent_review_pass_count: 1 },
          review: { agent_review_pass_count: 1 },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'mission-live',
      objective: 'Keep loop alive',
      status: 'running',
      verifier: 'npm test',
    })}\n`, 'utf8');

    const res = runCli(['launchpad', '--json', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.schema, 'atris.launchpad.v1');
    assert.equal(payload.next_action.kind, 'continue_claimed_task');
    assert.equal(payload.next_action.command, 'atris task step CLI-9');
    assert.equal(payload.counts.review_needs_agent, 1);
    assert.equal(payload.counts.missions_need_tick, 1);
    assert.deepEqual(payload.suggestions.map(item => item.title), [
      'Finish current work',
      'Run the paused live job',
      'Check a finished change',
    ]);
    assert.equal(payload.suggestions[0].subject, 'Ship launchpad');
    assert.equal(payload.suggestions[0].ref, 'CLI-9');
  } finally {
    cleanupTempDir(dir);
  }
});


test('launchpad --json reports clean review queue and endgame seed action', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO',
      '',
      '## Endgame',
      '',
      '**Slug:** autopilot-runner-agnostic',
      '**Horizon:** runner swaps should be config-only',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), '# Status\n\n## Next Move\n\nSeed work.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [],
    }, null, 2), 'utf8');

    const res = runCli(['launchpad', '--json', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.counts.open, 0);
    assert.equal(payload.counts.review, 0);
    assert.equal(payload.counts.review_needs_agent, 0);
    assert.equal(payload.counts.review_certified, 0);
    assert.equal(payload.next_action.kind, 'seed_endgame_task');
    assert.equal(payload.next_action.command, 'atris task next --create-next');
    assert.equal(payload.next_action.endgame.slug, 'autopilot-runner-agnostic');
  } finally {
    cleanupTempDir(dir);
  }
});


test('launchpad chooses a verifier mission when there is no owned claimed task', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'brain', 'STATUS.md'), '# Status\n\n## Next Move\n\nSeed work.\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        {
          id: 'task-review',
          display_id: 'CLI-10',
          title: 'Check finished work',
          status: 'review',
          claimed_by: 'claude',
          updated_at: 20,
          metadata: { agent_review_pass_count: 1 },
          review: { agent_review_pass_count: 1 },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      id: 'mission-verify',
      objective: 'Ship one checked loop',
      status: 'ready',
      verifier: 'node --test',
    })}\n`, 'utf8');

    const res = runCli(['launchpad', '--as', 'codex'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Live job waiting on a check/);
    assert.match(res.stdout, /Ship one checked loop/);
    assert.match(res.stdout, /RUN THIS\n\s+atris mission tick mission-verify --verify --complete-on-pass/);
    assert.match(res.stdout, /WHAT HAPPENED\n\s+Ship one checked loop/);
    assert.match(res.stdout, /WHAT TO WORK ON NEXT\n\s+1\. Run the paused live job/);
    assert.match(res.stdout, /2\. Check a finished change/);
    assert.match(res.stdout, /An always-on job is paused until its check runs\./);
    assert.doesNotMatch(res.stdout, /proof|review-chat|agent review/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('init scaffolds atris/wiki/briefs instead of syntheses', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs')));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'syntheses')), false);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Atris is the source of truth/);
    assert.match(agents, /AGENTS\.md`; do not turn it into a parallel brain/);
    assert.match(agents, /`atris\/atris\.md` \| Protocol\/backbone/);
    assert.match(agents, /`atris task ready <id> --proof/);
    assert.match(agents, /Human accept\s+-> task Done \+ AgentXP awarded/);
    assert.doesNotMatch(agents, /task finish <id> --proof/);
    const claudeCommand = fs.readFileSync(path.join(dir, '.claude', 'commands', 'atris.md'), 'utf8');
    assert.match(claudeCommand, /atris\/atris\.md/);
    assert.match(claudeCommand, /AGENTS\.md is only a tool adapter/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('init scaffolds Devin permission for Atris command access', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const configPath = path.join(dir, '.devin', 'config.local.json');
    assert.ok(fs.existsSync(configPath));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.permissions.allow, ['Exec(atris)']);
  } finally {
    cleanupTempDir(dir);
  }
});


test('agent doctor verifies local AI CLI wiring without auth', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['agent', 'doctor', '--account', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'agent_doctor');
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.checks.map((check) => [check.id, check.ok]),
      [
        ['atris-core', true],
        ['codex', true],
        ['claude', true],
        ['cursor', true],
        ['devin', true],
      ]
    );
    assert.ok(payload.binaries.some((binary) => binary.name === 'devin'));
    assert.ok(payload.binaries.some((binary) => binary.name === 'agy'));
  } finally {
    cleanupTempDir(dir);
  }
});


test('agent help hides internal dogfood diagnostic', () => {
  const dir = makeTempDir();
  let res;
  try {
    res = runCli(['agent', '--help'], { cwd: dir });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, /dogfood/);
  assert.match(res.stdout, /Usage: atris agent \[doctor\|spawn\|spawns\|spawn-status\]/);
});


test('agent dogfood is gated from public CLI', () => {
  const dir = makeTempDir();
  let res;
  try {
    res = runCli(['agent', 'dogfood', '--help'], { cwd: dir });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(res.status, 1);
  assert.match(res.stderr, /internal diagnostic/);
  assert.match(res.stderr, /atris agent doctor/);
});


test('agent dogfood help is available only behind internal gate', () => {
  const dir = makeTempDir();
  let res;
  try {
    res = runCli(['agent', 'dogfood', '--help'], {
      cwd: dir,
      env: { ...process.env, ATRIS_INTERNAL_AGENT_DOGFOOD: '1' },
    });
  } finally {
    cleanupTempDir(dir);
  }
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /Internal usage: atris agent dogfood/);
});


test('agent spawn creates a durable worker request without auth', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['agent', 'spawn', 'worker', '--task', 'Fix one bounded bug', '--engine', 'codex', '--account', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'spawn_created');
    assert.equal(payload.request.role, 'worker');
    assert.equal(payload.request.task, 'Fix one bounded bug');
    assert.equal(payload.request.engine, 'codex');
    assert.match(payload.request.command, /^codex exec /);

    const list = runCli(['agent', 'spawns', '--account', '--json'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.equal(JSON.parse(list.stdout).requests.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business slug matcher accepts config aliases', () => {
  const business = {
    slug: 'acme',
    name: 'Acme Co',
    config: { aliases: ['atris'] },
  };

  assert.equal(businessMatchesSlug(business, 'acme'), true);
  assert.equal(businessMatchesSlug(business, 'atris'), true);
  assert.equal(businessMatchesSlug(business, 'Acme Co'), false);
  assert.equal(businessMatchesSlug(business, 'Acme Co', { includeName: true }), true);
});


test('business doctor plans safe cache repoints for stale duplicate rows', () => {
  const active = {
    id: 'active-example',
    slug: 'example-customer-ops',
    name: 'example-customer-ops',
    workspace_id: 'active-workspace',
    config: {},
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [active],
    cache: {
      'example-customer-ops': {
        business_id: 'deleted-duplicate',
        workspace_id: 'deleted-workspace',
        name: 'example-customer-ops',
        slug: 'example-customer-ops-1',
      },
    },
    folderBindings: [],
  });

  assert.ok(analysis.issues.some((issue) => issue.code === 'stale-cache-repoint'));
  assert.equal(analysis.cacheUpdates['example-customer-ops'].business_id, 'active-example');
  assert.equal(analysis.cacheUpdates['example-customer-ops'].workspace_id, 'active-workspace');
  assert.equal(analysis.cacheUpdates['example-customer-ops'].slug, 'example-customer-ops');
});


test('business doctor accepts clean alias folders and asks for missing alias cache', () => {
  const atrisLabs = {
    id: 'biz-acme',
    slug: 'acme',
    name: 'Acme Co',
    workspace_id: 'workspace-acme',
    config: { aliases: ['atris'] },
  };
  const analysis = analyzeBusinessDoctor({
    cloudBusinesses: [atrisLabs],
    cache: {
      'acme': {
        business_id: 'biz-acme',
        workspace_id: 'workspace-acme',
        name: 'Acme Co',
        slug: 'acme',
      },
    },
    folderBindings: [{
      name: 'atris',
      isSymlink: false,
      hasAtris: true,
      hasBusinessJson: true,
      meta: {
        business_id: 'biz-acme',
        workspace_id: 'workspace-acme',
        name: 'Acme Co',
        slug: 'atris',
        canonical_slug: 'acme',
      },
    }],
  });

  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-name-not-slug-or-alias'), false);
  assert.equal(analysis.issues.some((issue) => issue.code === 'folder-slug-mismatch'), false);
  assert.equal(analysis.cacheUpdates.atris.business_id, 'biz-acme');
  assert.equal(analysis.cacheUpdates.atris.canonical_slug, 'acme');
});


test('ensureWikiScaffold migrates legacy syntheses pages into briefs', () => {
  const dir = makeTempDir();
  try {
    const wikiDir = path.join(dir, 'atris', 'wiki');
    const legacyDir = path.join(wikiDir, 'syntheses');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'index.md'),
      '# Atris Wiki Index\n\n## Syntheses\n\n- [[atris/wiki/syntheses/example.md]]\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyDir, 'example.md'),
      '---\ntype: synthesis\nslug: example\ntitle: Example\n---\n# Example\n',
      'utf8'
    );

    ensureWikiScaffold(dir);

    const briefsPath = path.join(wikiDir, 'briefs', 'example.md');
    assert.ok(fs.existsSync(briefsPath));
    assert.equal(fs.existsSync(legacyDir), false);
    assert.match(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /## Briefs/);
    assert.doesNotMatch(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /syntheses/);
    assert.match(fs.readFileSync(briefsPath, 'utf8'), /^type: brief$/m);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search without workspace data prints compact empty result', () => {
  const dir = makeTempDir();
  try {
    // an atris folder exists but is empty: compact rows, not the init hint
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Feature: none/);
    assert.match(res.stdout, /Journal: none/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search finds matches in journal files', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Fix the auth module\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Journal:\n- atris\/logs\/\d{4}\/\d{4}-\d{2}-\d{2}\.md:5: - \*\*I1:\*\* Fix the auth module/);
    assert.match(res.stdout, /auth/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search is case-insensitive', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nDebugged the AUTH flow\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Journal:\n- atris\/logs\/\d{4}\/\d{4}-\d{2}-\d{2}\.md:5: Debugged the AUTH flow/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('search with no matches prints no matches', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nNothing relevant here\n');
    const res = runCli(['search', 'xyznonexistent'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Journal: none/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// analytics
// ============================================

test('analytics exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('analytics shows zero completions on fresh workspace', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Total completions:\s+0/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('analytics counts completions in journal', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n- **C1: Shipped auth**\n- **C2: Fixed bug**\n\n## Inbox\n\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Today should show 2 completions
    assert.match(res.stdout, /2/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('analytics counts inbox items when Inbox is last section', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Inbox at the end with no ## or --- after it (regression test)
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n---\n\n## Inbox\n\n- **I1:** Fix auth\n- **I2:** Add tests\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Inbox items:\s+2/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('getRecentSignals returns empty commit/wiki/lesson signals when sources are missing', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.rmSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), { force: true });
    fs.rmSync(path.join(dir, 'atris', 'lessons.md'), { force: true });

    const signals = getRecentSignals(dir);
    assert.deepEqual(signals.recentCommits, []);
    assert.equal(signals.wikiHealth, null);
    assert.deepEqual(signals.recentLessons, []);
  } finally {
    cleanupTempDir(dir);
  }
});


test('getRecentSignals reads recent git commits, wiki health, and last 10 lesson lines', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const initResult = runGit(['init'], dir);
    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    const commitResult = runGit(['commit', '-m', 'seed workspace'], dir);
    assert.equal(commitResult.status, 0, commitResult.stderr);

    const statusPath = path.join(dir, 'atris', 'wiki', 'STATUS.md');
    fs.writeFileSync(statusPath, '# STATUS\n\nHealth: 3/5\nNext move: tighten loop\n', 'utf8');

    const lessonsPath = path.join(dir, 'atris', 'lessons.md');
    const lessonLines = Array.from({ length: 12 }, (_, i) => `- lesson ${i + 1}`);
    fs.writeFileSync(lessonsPath, `${lessonLines.join('\n')}\n`, 'utf8');

    const signals = getRecentSignals(dir);
    assert.equal(signals.recentCommits.length, 1);
    assert.match(signals.recentCommits[0], /seed workspace/);
    assert.match(signals.wikiHealth, /Health: 3\/5/);
    assert.equal(signals.recentLessons.length, 10);
    assert.deepEqual(signals.recentLessons, lessonLines.slice(-10));
  } finally {
    cleanupTempDir(dir);
  }
});


test('renderHumanTickIntro keeps the default autopilot briefing plain and narrow', () => {
  const text = renderHumanTickIntro({
    time: '11:20 a.m.',
    identity: 'Ship one clean step at a time.',
    slug: 'loop-self-seeds-horizons',
    horizon: 'Teach the loop to imagine the next horizon when the queue goes quiet.',
    total: 5,
    done: 2
  }, {
    auto: true,
    durationLabel: 'until clean'
  });

  assert.match(text, /I am starting an autopilot tick in autonomous mode\./);
  assert.match(text, /Progress is 2 of 5 endgame steps\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});


test('renderHumanSuggestion keeps the default suggestion briefing plain and narrow', () => {
  const text = renderHumanSuggestion({
    task: 'Rewrite the autopilot tick output to match the chief-of-staff format.',
    why: 'The current box-heavy output makes it hard for a non-technical reader to decide whether to let the loop continue.',
    kind: 'execute'
  }, 1, 4);

  assert.match(text, /I picked task 1 of 4\./);
  assert.match(text, /Next: approve it, skip it, or stop the loop\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});


// ============================================
// visualize
// ============================================

test('visualize exits 1 when no journal exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Remove any auto-created log
    const logsDir = path.join(dir, 'atris', 'logs');
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris log/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('visualize exits 1 when inbox is empty', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Inbox|inbox/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('visualize renders breakdown for inbox items', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Build the dashboard\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Build the dashboard/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('visualize dry-run accepts any prompt without requiring inbox', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['visualize', 'show the connect-api workflow for onboarding', '--dry-run'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Visualize dry run/);
    assert.match(res.stdout, /gpt-image-2/);
    assert.match(res.stdout, /connect-api workflow/);
    assert.match(res.stdout, /Artifact type: workflow/);
    assert.match(res.stdout, /atris\/reports\/visuals/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('visualize dry-run supports custom output and raw prompt', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli([
      'visualize',
      'exact raw diagram prompt',
      '--dry-run',
      '--raw',
      '--out',
      'custom/path.png',
    ], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /custom\/path\.png/);
    assert.match(res.stdout, /exact raw diagram prompt/);
    assert.doesNotMatch(res.stdout, /Workspace context to respect/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// clean
// ============================================

test('clean exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('clean --json reports missing atris folder without text chrome', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean', '--json'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'clean');
    assert.match(payload.error, /atris\/ folder not found/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('clean --help prints usage without touching workspace', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris clean/);
    assert.match(res.stdout, /--dry-run/);
    assert.match(res.stdout, /--json/);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('clean --dry-run --json reports machine-readable health', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /Atris Clean/);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'clean');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.results.stale_tasks.count, 0);
    assert.equal(typeof payload.results.map_refs.healed_count, 'number');
    assert.equal(payload.results.map_refs.verb, 'would_heal');
    assert.equal(Array.isArray(payload.results.map_refs.items), true);
    assert.equal(typeof payload.results.stale_pages.count, 'number');
    assert.equal(Array.isArray(payload.results.stale_pages.items), true);
    assert.equal(Array.isArray(payload.manual_action), true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('clean dry-run shows MAP refs it would heal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), [
      'function main() {',
      '  return true;',
      '}',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), [
      '# MAP.md',
      '',
      '- `src/app.js:20` (`main`)',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['clean', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.results.map_refs.healed_count, 1);
    assert.deepEqual(payload.results.map_refs.items, [
      {
        old: '`src/app.js:20`',
        new: '`src/app.js:1`',
        symbol: 'main',
      },
    ]);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8'), /src\/app\.js:20/);

    const text = runCli(['clean', '--dry-run'], { cwd: dir });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Would heal 1 MAP\.md reference/);
    assert.match(text.stdout, /`src\/app\.js:20` -> `src\/app\.js:1` \(main\)/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('clean reports clean workspace on fresh init', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Should complete without crashing
    assert.match(res.stdout, /clean|stale|target/i);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// verify
// ============================================

test('verify exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('verify detects placeholder MAP.md', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // init creates a placeholder MAP.md; verify correctly fails when MAP has issues
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 1, res.stderr);
    // Should mention MAP issues since it's a placeholder
    assert.match(res.stdout, /MAP\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('verify passes with populated MAP.md', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Write a MAP.md with enough file refs (verify regex: `filename.ext` with known extensions)
    const mapContent = [
      '# MAP.md', '',
      '## By-Feature',
      '- auth: `bin/atris.js` line 1',
      '- init: `commands/init.js` line 10',
      '- sync: `commands/sync.js` line 20',
      '- status: `commands/status.js` line 30',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), mapContent, 'utf8');
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /MAP\.md.*Valid/i);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// sync alias
// ============================================

test('sync command works as alias for update', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['update', '--yes'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /up to date|Updated/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('update and sync --help print usage without touching workspace', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const skillFile = path.join(home, '.codex', 'skills', 'improve', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    for (const command of ['update', 'sync']) {
      fs.writeFileSync(skillFile, 'operator-owned skill\n', 'utf8');
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.match(res.stdout, /--dry-run/);
      assert.doesNotMatch(res.stdout, /Updating|Local workspace updated|up to date/i);
      assert.doesNotMatch(res.stdout, /skills updated/i);
      assert.equal(fs.readFileSync(skillFile, 'utf8'), 'operator-owned skill\n');
    }
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('upgrade --help prints usage without npm update checks', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['upgrade', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris upgrade/);
    assert.doesNotMatch(res.stdout, /Checking for updates|Installing update|npm install -g atris@latest/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('now --help prints usage without update-check side effects', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['now', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris now/);
    assert.doesNotMatch(res.stdout, /Current operating truth|Created atris\/now\.md/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('help invocations skip background update-check cache writes', () => {
  const dir = makeTempDir();
  try {
    const commands = [
      ['skill', '--help'],
      ['member', '--help'],
      ['plugin', '--help'],
      ['experiments', '--help'],
      ['receipt', '--help'],
      ['code-review', '--help'],
    ];

    for (const args of commands) {
      const home = path.join(dir, `home-${args[0]}`);
      const res = runCli(args, { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr || res.stdout}`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${args.join(' ')} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('status and analytics --help print usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['status', 'analytics']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${command}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /atris\/ folder not found|Atris Analytics|Current Status/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${command} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${command} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('brain --help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const flag of ['--help', '-h']) {
      const res = runCli(['brain', flag], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `brain ${flag}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris brain compile/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `brain ${flag} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `brain ${flag} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('brainstorm help prints usage without workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const helpArg of ['--help', '-h', 'help']) {
      const res = runCli(['brainstorm', helpArg], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `brainstorm ${helpArg}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, /Usage: atris brainstorm/);
      assert.doesNotMatch(res.stderr, /atris\/ folder not found/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `brainstorm ${helpArg} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `brainstorm ${helpArg} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('auth --help prints usage without auth side effects', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['login', 'whoami']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /Choose login method|Status: Not logged in|Run "atris login"/);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false);
    }

    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    const credentialsPath = path.join(home, '.atris', 'credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({
      token: 'fake',
      email: 'fake@example.com',
      provider: 'manual',
    }, null, 2), 'utf8');
    const before = fs.readFileSync(credentialsPath, 'utf8');
    const logout = runCli(['logout', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(logout.status, 0, logout.stderr);
    assert.match(logout.stdout, /Usage: atris logout/);
    assert.doesNotMatch(logout.stdout, /Signed out/);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before);
  } finally {
    cleanupTempDir(dir);
  }
});


test('account and integrations --help print usage without session side effects', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['switch', 'use', 'accounts', 'integrations']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${command}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /No saved accounts|Not signed in|Set per-terminal account|Integration Status/);
      assert.doesNotMatch(res.stderr, /Not logged in|Run: atris login/);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${command} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('setup --help prints usage without entering setup flow', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['setup', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris setup/);
    assert.doesNotMatch(res.stdout, /Atris Setup|Starting login|Choose login method/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('activate and next --help print usage without loading workflow context', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    for (const command of ['activate', 'next']) {
      const res = runCli([command, '--help'], { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${command}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, new RegExp(`Usage: atris ${command}`));
      assert.doesNotMatch(res.stdout, /CONTEXT LOADED|Context Loaded|Atris Activate|Atris Plan|Completed \(preview\)/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${command} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${command} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('serve --help prints usage instead of entering planner or bridge', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['serve', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris serve/);
    assert.doesNotMatch(res.stdout, /CONTEXT LOADED|Atris Plan|Local AI Computer Bridge|Not logged in/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('loop --help prints usage without running wiki loop', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['loop', '--help'], { cwd: dir, env: { HOME: home } });
	    assert.equal(res.status, 0, res.stderr);
	    assert.match(res.stdout, /Usage: atris loop/);
	    assert.match(res.stdout, /atris loop wiki/);
	    assert.doesNotMatch(res.stdout, /Wiki Loop|Pages:|Health: wiki/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('verify --help prints usage without running verifier', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO.md\n\n## Completed\n- **[HELP-1]** verify help sentinel\n', 'utf8');
    const res = runCli(['verify', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris verify/);
    assert.match(res.stdout, /--section <name>/);
    assert.doesNotMatch(res.stdout, /Atris Verify|Verifying:|Verifying workspace|Tests:/);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('release --help prints usage without changing package metadata', () => {
  const dir = makeTempDir();
  try {
    const pkgPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'demo-release', version: '1.2.3' }, null, 2), 'utf8');
    const before = fs.readFileSync(pkgPath, 'utf8');
    const res = runCli(['release', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris release/);
    assert.match(res.stdout, /--dry-run/);
    assert.doesNotMatch(res.stdout, /commits since|bump type|bumped package/);
    assert.equal(fs.readFileSync(pkgPath, 'utf8'), before);
  } finally {
    cleanupTempDir(dir);
  }
});


test('createCanonicalBusinessWorkspace writes business metadata and canonical atris scaffold into an existing folder', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'EXAMPLE_NOTES.md'), '# raw notes\n', 'utf8');

    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'Example Co',
      slug: 'example-co',
      owner_email: 'operator@example.com',
    }, { here: true });

    assert.equal(result.targetRoot, dir);
    assert.ok(fs.existsSync(path.join(dir, 'EXAMPLE_NOTES.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'goals.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'PERSONA.md')));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(dir, 'GEMINI.md')));
    assert.ok(fs.readdirSync(path.join(dir, 'atris')).includes('PERSONA.md'));
    assert.equal(fs.readdirSync(path.join(dir, 'atris')).includes('persona.md'), false);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'policies', 'REWARD.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'context', 'live-workspace.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', '_sync.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'runtime.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'reports', 'operating-recap-template.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'concepts', 'first-loop-template.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'START_HERE.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', '_template', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'operator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'validator', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'ops', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'comms', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'research', 'MEMBER.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.slug, 'example-co');
    assert.equal(meta.business_id, 'biz-123');
    assert.equal(meta.workspace_id, 'ws-456');
    assert.equal(meta.workspace_template, 'business');
    assert.equal(meta.owner_email, 'operator@example.com');

    const syncMeta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', '_sync.json'), 'utf8'));
    assert.equal(syncMeta.workspace_slug, 'example-co');
    assert.equal(syncMeta.business_id, 'biz-123');
    assert.equal(syncMeta.workspace_id, 'ws-456');
    assert.equal(syncMeta.workspace_template, 'business');

    const runtime = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'runtime.json'), 'utf8'));
    assert.equal(runtime.schema, 'atris.runtime.v1');
    assert.equal(runtime.scope, 'local-business-computer');
    assert.equal(runtime.install_status, 'local_cli_present');
    assert.equal(runtime.sync_status, 'templates_seeded');
    assert.deepEqual(runtime.agent_adapters, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

    const rootAgents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(rootAgents, /Example Co Atris Workspace/);
    assert.match(rootAgents, /atris business start/);
    assert.match(rootAgents, /atris radar/);
    assert.match(rootAgents, /atris task next/);
    assert.match(rootAgents, /atris member activate operator/);
    assert.match(rootAgents, /atris mission start "Run the first useful loop for Example Co"/);
    assert.match(rootAgents, /atris do/);
    assert.match(rootAgents, /atris task ready <id> --proof/);
    assert.match(rootAgents, /Do not run `atris task accept` or claim XP unless a human approved the proof/);
    assert.match(rootAgents, /atris business share --write/);
    assert.match(rootAgents, /atris sync --dry-run/);
    assert.match(rootAgents, /atris sync --watch/);

    const map = fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8');
    assert.match(map, /Example Co/);
    assert.match(map, /\.atris\/state\/events\.jsonl/);
    assert.match(map, /atris\/team\/START_HERE\.md/);

    const teamStart = fs.readFileSync(path.join(dir, 'atris', 'team', 'START_HERE.md'), 'utf8');
    assert.match(teamStart, /Run `atris radar`/);
    assert.match(teamStart, /Claim the seeded first task with `atris task next`/);
    assert.match(teamStart, /Wake `operator` with `atris member activate operator`/);
    assert.match(teamStart, /atris mission start "Run the first useful loop for this business"/);
    assert.match(teamStart, /atris member goal-from-mission operator/);
    assert.match(teamStart, /Execute the loop with `atris do`/);
    assert.match(teamStart, /Ask `validator` to check proof/);
    assert.match(teamStart, /atris sync --dry-run/);
    assert.match(teamStart, /atris sync --watch/);

    const persona = fs.readFileSync(path.join(dir, 'atris', 'PERSONA.md'), 'utf8');
    assert.match(persona, /Example Co/);

    const reward = fs.readFileSync(path.join(dir, 'atris', 'policies', 'REWARD.md'), 'utf8');
    assert.match(reward, /Reward what makes the operator faster/i);
    assert.match(reward, /events\.jsonl/);

    const liveWorkspace = fs.readFileSync(path.join(dir, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(liveWorkspace, /biz-123/);
    assert.match(liveWorkspace, /ws-456/);
    assert.match(liveWorkspace, /Structured State/);

    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /## Endgame/);
    assert.match(todo, /\*\*B1:\*\*/);
    assert.match(todo, /\[endgame\]/);
    assert.match(todo, /\*\*Verify:\*\*/);
    assert.match(todo, /first measurable loop/i);
    assert.match(todo, /named human/i);
    assert.match(todo, /structured state entries/i);

    const teamReadme = fs.readFileSync(path.join(dir, 'atris', 'team', 'README.md'), 'utf8');
    assert.match(teamReadme, /real humans/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business workspace scaffold preserves existing root agent adapter files', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Custom Agent Rules\n', 'utf8');

    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-preserve',
      workspace_id: 'ws-preserve',
      name: 'Preserve Co',
      slug: 'preserve-co',
      owner_email: 'team@preserve.co',
    }, { here: true });

    assert.deepEqual(result.agentAdapters, ['CLAUDE.md', 'GEMINI.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Custom Agent Rules\n');
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Preserve Co Atris Workspace/);
    assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /atris task next/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business sync repairs missing root agent adapters without overwriting custom ones', () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-repair',
      workspace_id: 'ws-repair',
      name: 'Repair Co',
      slug: 'repair-co',
      owner_email: 'team@repair.co',
    }, { here: true });

    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Custom Agent Rules\n', 'utf8');
    fs.rmSync(path.join(dir, 'CLAUDE.md'), { force: true });
    fs.rmSync(path.join(dir, 'GEMINI.md'), { force: true });

    const beforeCustom = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    const res = runCli(['update', '--yes'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), beforeCustom);
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /Repair Co Atris Workspace/);
    assert.match(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), /atris mission status --status active --json/);
    assert.match(res.stdout, /Root agent adapters:/);
    assert.match(res.stdout, /\+ CLAUDE\.md/);
    assert.match(res.stdout, /\+ GEMINI\.md/);

    const state = collectBusinessShareState(dir);
    assert.deepEqual(state.missingRootAgentAdapters, []);
    assert.equal(state.missing.includes('root agent adapters'), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('createCanonicalBusinessWorkspace can scaffold a research lab template', () => {
  const dir = makeTempDir();
  try {
    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-r1',
      workspace_id: 'ws-r2',
      name: 'Frontier Lab',
      slug: 'frontier-lab',
      owner_email: 'pi@frontier.lab',
      workspace_template: 'research',
    }, { here: true, templateName: 'research' });

    assert.equal(result.targetRoot, dir);
    assert.equal(result.workspaceTemplate, 'research');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', '_sync.json')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'episodes.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'hypothesis', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'eval', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'concepts', 'research-loop.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs', 'research-program.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.workspace_template, 'research');

    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /## Endgame/);
    assert.match(todo, /\*\*R1:\*\*/);
    assert.match(todo, /\[endgame\]/);
    assert.match(todo, /\*\*Verify:\*\*/);

    const reward = fs.readFileSync(path.join(dir, 'atris', 'policies', 'REWARD.md'), 'utf8');
    assert.match(reward, /reproducible/i);
    assert.match(reward, /held-out|replayable/i);

    const liveWorkspace = fs.readFileSync(path.join(dir, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(liveWorkspace, /research/i);
    assert.match(liveWorkspace, /biz-r1/);
    assert.match(liveWorkspace, /ws-r2/);

    const teamReadme = fs.readFileSync(path.join(dir, 'atris', 'team', 'README.md'), 'utf8');
    assert.match(teamReadme, /hypothesis, experiment, eval, literature/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business help exposes default workspace creation', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['business'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /init <name>/);
    assert.match(res.stdout, /create <name>/);
    assert.match(res.stdout, /start\s+Check a received business workspace/);
    assert.match(res.stdout, /business environment/i);
    assert.doesNotMatch(res.stdout, /canonical business workspace/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business quickstart includes the full first-loop operating path', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['business', 'quickstart'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Start a Business With An Operating Loop/);
    assert.match(res.stdout, /atris business start/);
    assert.match(res.stdout, /atris radar/);
    assert.match(res.stdout, /atris task next/);
    assert.match(res.stdout, /atris member activate operator/);
    assert.match(res.stdout, /atris mission status --status active --json/);
    assert.match(res.stdout, /atris mission start "Run the first useful loop for My Company"/);
    assert.match(res.stdout, /atris member goal-from-mission operator/);
    assert.match(res.stdout, /atris business onboard --website https:\/\/example\.com --contact "Founder Name" --note "what they do"/);
    assert.match(res.stdout, /atris do/);
    assert.match(res.stdout, /atris business record atris\/reports\/YYYY-MM-DD-your-recap\.md --outcome mixed --metric "operator speed"/);
    assert.match(res.stdout, /Write the handoff before sharing/);
    assert.match(res.stdout, /atris business share --write/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris sync --watch/);
    assert.match(res.stdout, /Repeat:[\s\S]*atris radar -> atris task next -> atris do -> record -> share/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business init next steps include start task mission record share and sync', () => {
  const rendered = renderBusinessCreatedNextSteps({
    name: 'Loop Works',
    slug: 'loop-works',
  }, '/tmp/loop-works');

  assert.match(rendered, /seeded local computer \+ operator \+ validator/);
  assert.match(rendered, /cd \/tmp\/loop-works/);
  assert.match(rendered, /atris business start/);
  assert.match(rendered, /atris radar/);
  assert.match(rendered, /atris task next/);
  assert.match(rendered, /atris member activate operator/);
  assert.match(rendered, /atris mission status --status active --json/);
  assert.match(rendered, /atris mission start "Run the first useful loop for Loop Works"/);
  assert.match(rendered, /atris member goal-from-mission operator/);
  assert.match(rendered, /atris business onboard --website <url> --contact "Name" --note "what they do"/);
  assert.match(rendered, /atris business record atris\/reports\/<recap>\.md --outcome mixed --metric "operator speed"/);
  assert.match(rendered, /atris business share --write/);
  assert.match(rendered, /atris sync --dry-run/);
  assert.match(rendered, /atris sync/);
});


test('fresh business environment starter exposes an endgame task with explicit verify', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'Example Co',
      slug: 'example-co',
      owner_email: 'operator@example.com',
      workspace_template: 'business',
    }, { here: true });

    const suggestion = await suggestNextTask(dir, new Set(), { auto: true });
    assert.equal(suggestion.kind, 'endgame');

    const verify = getVerifyCommand(dir, suggestion.task);
    assert.equal(verify.explicit, true);
    assert.match(verify.cmd, /find atris\/wiki\/concepts/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('fresh research environment starter exposes an endgame task with explicit verify', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-r1',
      workspace_id: 'ws-r2',
      name: 'Frontier Lab',
      slug: 'frontier-lab',
      owner_email: 'pi@frontier.lab',
      workspace_template: 'research',
    }, { here: true, templateName: 'research' });

    const suggestion = await suggestNextTask(dir, new Set(), { auto: true });
    assert.equal(suggestion.kind, 'endgame');

    const verify = getVerifyCommand(dir, suggestion.task);
    assert.equal(verify.explicit, true);
    assert.match(verify.cmd, /research-program\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business record appends recap state to all three workspace logs', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'Example Co',
      slug: 'example-co',
      owner_email: 'operator@example.com',
      workspace_template: 'business',
    }, { here: true });

    const reportPath = path.join(dir, 'atris', 'reports', '2026-04-12-operator-recap.md');
    fs.writeFileSync(reportPath, '# Operator Recap\n\nA real run happened.\n', 'utf8');

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await recordBusinessRun('atris/reports/2026-04-12-operator-recap.md', '--outcome', 'positive', '--metric', 'ticket pulse');
    } finally {
      process.chdir(prevCwd);
    }

    const events = fs.readFileSync(path.join(dir, '.atris', 'state', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const episodes = fs.readFileSync(path.join(dir, '.atris', 'state', 'episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const scorecards = fs.readFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

    assert.equal(events.length, 1);
    assert.equal(episodes.length, 1);
    assert.equal(scorecards.length, 1);
    assert.equal(events[0].type, 'report_recorded');
    assert.equal(episodes[0].type, 'episode');
    assert.equal(scorecards[0].type, 'scorecard');
    assert.equal(events[0].business_slug, 'example-co');
    assert.equal(events[0].report_path, 'atris/reports/2026-04-12-operator-recap.md');
    assert.equal(events[0].metric, 'ticket pulse');
    assert.equal(events[0].outcome, 'positive');
    assert.equal(events[0].reward, 5);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business onboard seeds intake, wiki pages, and a cheat sheet from sparse inputs', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-789',
      workspace_id: 'ws-789',
      name: 'Cashmere AI',
      slug: 'cashmere-ai',
      owner_email: 'team@cashmere.ai',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://cashmere.ai',
        '--contact', 'Farbod Nowzad',
        '--email', 'farbod@cashmere.ai',
        '--role', 'Founder',
        '--note', 'Warm proposal-stage account',
        '--note', 'Need a sharper first loop'
      );
    } finally {
      process.chdir(prevCwd);
    }

    const ingestRoot = path.join(dir, 'atris', 'context', '_ingest');
    const packs = fs.readdirSync(ingestRoot);
    assert.equal(packs.length, 1);
    assert.ok(fs.existsSync(path.join(ingestRoot, packs[0], 'intake.md')));
    assert.ok(fs.existsSync(path.join(ingestRoot, packs[0], 'links.txt')));
    assert.ok(fs.existsSync(path.join(ingestRoot, packs[0], 'sources.txt')));

    const briefPath = path.join(dir, 'atris', 'wiki', 'briefs', 'cashmere-ai-starter-brief.md');
    const personPath = path.join(dir, 'atris', 'wiki', 'people', 'farbod-nowzad.md');
    const conceptPath = path.join(dir, 'atris', 'wiki', 'concepts', 'cashmere-ai-first-loop.md');
    const cheatSheetPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-cashmere-ai-onboarding-cheat-sheet.md`);
    const onePagerPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-cashmere-ai-operator-one-pager.md`);

    assert.ok(fs.existsSync(briefPath));
    assert.ok(fs.existsSync(personPath));
    assert.ok(fs.existsSync(conceptPath));
    assert.ok(fs.existsSync(cheatSheetPath));
    assert.ok(fs.existsSync(onePagerPath));

    assert.match(fs.readFileSync(briefPath, 'utf8'), /Warm proposal-stage account/);
    assert.match(fs.readFileSync(personPath, 'utf8'), /Farbod Nowzad/);
    assert.match(fs.readFileSync(conceptPath, 'utf8'), /Candidate Loop/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /Next 3 Moves/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /Best Next Action/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /atris business share --write/);
    assert.match(fs.readFileSync(cheatSheetPath, 'utf8'), /Swarlo join/);
    assert.match(fs.readFileSync(onePagerPath, 'utf8'), /One Pager/);
    assert.match(fs.readFileSync(onePagerPath, 'utf8'), /Swarlo join/);

    const index = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), 'utf8');
    assert.match(index, /\[\[atris\/wiki\/briefs\/cashmere-ai-starter-brief\.md\]\]/);
    assert.match(index, /\[\[atris\/wiki\/people\/farbod-nowzad\.md\]\]/);
    assert.match(index, /\[\[atris\/wiki\/concepts\/cashmere-ai-first-loop\.md\]\]/);

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /starter onboarding compiled/);
    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /ONBOARD starter onboarding compiled for cashmere-ai/);

    const todoContent = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todoContent, /\[execute\]/);
    assert.match(todoContent, /Draft a founder-context note/);
    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some(task =>
      task.title.includes('Draft a founder-context note')
      && task.status === 'open'
      && task.tag === 'execute'
      && task.metadata?.source === 'business_onboard'
    ));
    const next = runCli(['task', 'next', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.match(nextPayload.task.title, /Draft a founder-context note/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business onboard can infer signals from sloppy input and local files', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-900',
      workspace_id: 'ws-900',
      name: 'Northstar Ops',
      slug: 'northstar-ops',
      owner_email: 'team@northstar.ops',
      workspace_template: 'business',
    }, { here: true });

    fs.writeFileSync(path.join(dir, 'meeting-notes.md'), '# Notes\n\nSite: https://northstarops.ai\n', 'utf8');

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness('sleep deprived onboarding', 'need something useful fast');
    } finally {
      process.chdir(prevCwd);
    }

    const briefPath = path.join(dir, 'atris', 'wiki', 'briefs', 'northstar-ops-starter-brief.md');
    const onePagerPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-northstar-ops-operator-one-pager.md`);
    const sourcesRoot = path.join(dir, 'atris', 'context', '_ingest');
    const pack = fs.readdirSync(sourcesRoot)[0];
    const sourcesTxt = fs.readFileSync(path.join(sourcesRoot, pack, 'sources.txt'), 'utf8');

    assert.ok(fs.existsSync(briefPath));
    assert.ok(fs.existsSync(onePagerPath));
    assert.match(fs.readFileSync(briefPath, 'utf8'), /Website: https:\/\/northstarops\.ai/);
    assert.match(fs.readFileSync(briefPath, 'utf8'), /sleep deprived onboarding need something useful fast/);
    assert.match(fs.readFileSync(onePagerPath, 'utf8'), /Map the offer into one loop|Extract the first workflow from local evidence/);
    assert.match(sourcesTxt, /meeting-notes\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business onboard bootstraps from bare directory with --name flag', async () => {
  const dir = makeTempDir();
  try {
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--name', 'Acme Corp',
        '--website', 'https://acme.com',
        '--contact', 'Jane Doe',
        '--email', 'jane@acme.com'
      );
    } finally {
      process.chdir(prevCwd);
    }

    const bizFile = path.join(dir, '.atris', 'business.json');
    assert.ok(fs.existsSync(bizFile), '.atris/business.json should exist');
    const meta = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
    assert.equal(meta.name, 'Acme Corp');
    assert.equal(meta.slug, 'acme-corp');

    const briefPath = path.join(dir, 'atris', 'wiki', 'briefs', 'acme-corp-starter-brief.md');
    assert.ok(fs.existsSync(briefPath), 'starter brief should exist');
    assert.match(fs.readFileSync(briefPath, 'utf8'), /Jane Doe/);

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    assert.ok(fs.existsSync(todoPath), 'TODO.md should exist');
    const todoContent = fs.readFileSync(todoPath, 'utf8');
    assert.match(todoContent, /Backlog/);
    assert.match(todoContent, /\[execute\]/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business share prints and writes a collaborator handoff from workspace state', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-share',
      workspace_id: 'ws-share',
      name: 'Share Co',
      slug: 'share-co',
      owner_email: 'team@share.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://share.co',
        '--contact', 'Sam Share',
        '--email', 'sam@share.co',
        '--note', 'Needs a clean collaborator handoff'
      );
      fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-recap.md'), '# First Recap\n\nUseful loop happened.\n', 'utf8');
      await recordBusinessRun('atris/reports/first-recap.md', '--outcome', 'positive', '--metric', 'first loop');
      seedBusinessOsState(dir);
      await shareBusinessWorkspace('--role', 'operator', '--name', 'Sam Share', '--email', 'sam@share.co', '--write');
    } finally {
      process.chdir(prevCwd);
    }

    const handoffPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-share-operator.md`);
    assert.ok(fs.existsSync(handoffPath));
    const body = fs.readFileSync(handoffPath, 'utf8');
    assert.match(body, /Share Co Share Handoff/);
    assert.match(body, /For: Sam Share <sam@share\.co>/);
    assert.match(body, /Ready to share: yes/);
    assert.match(body, /Remote pull: available/);
    assert.match(body, /Get The Workspace/);
    assert.match(body, /atris pull share-co/);
    assert.match(body, /atris business start/);
    assert.match(body, /atris radar/);
    assert.match(body, /atris task next/);
    assert.match(body, /atris member activate operator/);
    assert.match(body, /## Start Here[\s\S]*atris member activate operator[\s\S]*atris mission status --status active --json[\s\S]*atris mission start "Run the first useful loop for Share Co"[\s\S]*atris member goal-from-mission operator/);
    assert.match(body, /atris mission start "Run the first useful loop for Share Co"/);
    assert.match(body, /atris member goal-from-mission operator/);
    assert.match(body, /Team start: atris\/team\/START_HERE\.md/);
    assert.match(body, /atris sync --dry-run/);
    assert.match(body, /atris sync --watch/);
    assert.match(body, /atris business record atris\/reports\/<recap>\.md/);
    assert.match(body, /Starter brief: atris\/wiki\/briefs\/share-co-starter-brief\.md/);
    assert.match(body, /First loop: atris\/wiki\/concepts\/share-co-first-loop\.md/);
    assert.match(body, /Scorecards: 1/);
    assert.match(body, /Atris OS State/);
    assert.match(body, /Tasks: 1 open, 1 claimed, 1 review \(1 certified\), 0 blocked/);
    assert.match(body, /Missions: 1 active, 1 running, 1 always-on, 0 stale\/no-verifier/);
    assert.match(body, /Team goals: 6 member lanes, 1 with active goals/);
    assert.match(body, /AgentXP: 12 total, 2 today, 1 receipts, integrity ok/);
    assert.match(body, /Loop: 1 mission ticks; Codex goal Keep the business loop moving/);
    assert.match(body, /XP gate: proof can move to Review; XP is awarded only after human approval/);
    assert.match(body, /atris radar/);
    assert.match(body, /atris mission status --status active --json/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business start gives a collaborator first-run card for a ready workspace', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-start',
      workspace_id: 'ws-start',
      name: 'Start Co',
      slug: 'start-co',
      owner_email: 'team@start.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://start.co',
        '--contact', 'Sid Start',
        '--email', 'sid@start.co',
        '--note', 'Needs a collaborator landing check'
      );
      fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-recap.md'), '# First Recap\n\nUseful loop happened.\n', 'utf8');
      await recordBusinessRun('atris/reports/first-recap.md', '--outcome', 'positive', '--metric', 'first loop');
      seedBusinessOsState(dir);
      await shareBusinessWorkspace('--role', 'operator', '--write');
    } finally {
      process.chdir(prevCwd);
    }

    const res = runCli(['business', 'start'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Start Co collaborator start/);
    assert.match(res.stdout, /Ready: yes/);
    assert.match(res.stdout, /Remote pull: available/);
    assert.match(res.stdout, /atris\/team\/START_HERE\.md/);
    assert.match(res.stdout, /atris\/wiki\/briefs\/start-co-starter-brief\.md/);
    assert.match(res.stdout, /atris sync --dry-run/);
    assert.match(res.stdout, /atris business start/);
    assert.match(res.stdout, /atris radar/);
    assert.match(res.stdout, /atris task next/);
    assert.match(res.stdout, /atris mission start "Run the first useful loop for Start Co"/);
    assert.match(res.stdout, /atris member goal-from-mission operator/);
    assert.match(res.stdout, /atris do/);
    assert.match(res.stdout, /atris business record atris\/reports\/<recap>\.md/);
    assert.match(res.stdout, /atris sync --watch/);
    assert.match(res.stdout, /OS:/);
    assert.match(res.stdout, /Tasks: 1 open, 1 claimed, 1 review \(1 certified\), 0 blocked/);
    assert.match(res.stdout, /Missions: 1 active, 1 running, 1 always-on, 0 stale\/no-verifier/);
    assert.match(res.stdout, /AgentXP: 12 total, 2 today, 1 receipts, integrity ok/);
    assert.match(res.stdout, /XP gate: proof can move to Review; XP is awarded only after human approval/);
    assert.match(res.stdout, /Work the first loop/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business handoff mission bootstrap executes in a generated workspace', () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-executable',
      workspace_id: 'ws-executable',
      name: 'Executable Co',
      slug: 'executable-co',
      owner_email: 'team@executable.co',
      workspace_template: 'business',
    }, { here: true });

    const startCard = runCli(['business', 'start'], { cwd: dir });
    assert.equal(startCard.status, 0, startCard.stderr);
    assert.match(startCard.stdout, /atris mission start "Run the first useful loop for Executable Co"/);

    const mission = runCli([
      'mission', 'start', '--no-verify', 'Run the first useful loop for Executable Co',
      '--owner', 'operator',
      '--runner', 'codex_goal',
      '--lane', 'business',
      '--verify', 'atris business check',
      '--stop', 'first proof recap recorded',
      '--json',
    ], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    const missionPayload = JSON.parse(mission.stdout);
    assert.equal(missionPayload.action, 'mission_started');
    assert.equal(missionPayload.mission.owner, 'operator');
    assert.equal(missionPayload.mission.runner, 'codex_goal');
    assert.equal(missionPayload.mission.lane, 'business');
    assert.equal(missionPayload.mission.verifier, 'atris business check');

    const goal = runCli(['member', 'goal-from-mission', 'operator', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
	    const goalPayload = JSON.parse(goal.stdout);
	    assert.equal(goalPayload.action, 'goal_from_mission_created');
	    assert.equal(goalPayload.goal.source, 'mission');
	    assert.equal(goalPayload.goal.mission_id, missionPayload.mission.id);
	    const ack = runCli([
	      'mission', 'goal', 'ack', missionPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Run the first useful loop for Executable Co',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const tick = runCli(['mission', 'tick', missionPayload.mission.id, '--verify', '--json', '--full'], {
      cwd: dir,
      env: { PATH: path.dirname(process.execPath) },
    });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'mission_tick');
    assert.equal(tickPayload.verifier_result.passed, true);
    assert.match(tickPayload.verifier_result.command, /atris business check/);
    assert.match(tickPayload.verifier_result.resolved_command, /bin\/atris\.js/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business collaborator handoff loop connects tasks missions goals proof and share state', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-loop',
      workspace_id: 'ws-loop',
      name: 'Loop Co',
      slug: 'loop-co',
      owner_email: 'team@loop.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://loop.co',
        '--contact', 'Liv Loop',
        '--email', 'liv@loop.co',
        '--note', 'Needs a complete collaborator proof loop'
      );
    } finally {
      process.chdir(prevCwd);
    }

    const next = runCli(['task', 'next', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const nextPayload = JSON.parse(next.stdout);
    assert.match(nextPayload.task.title, /Draft a founder-context note/);
    assert.equal(nextPayload.task.status, 'open');
    assert.equal(nextPayload.action, 'claim');
    assert.equal(runCli(['task', 'claim', nextPayload.task.display_id, '--as', 'operator'], { cwd: dir }).status, 0);

    const mission = runCli([
      'mission', 'start', '--no-verify', 'Run the first useful loop for Loop Co',
      '--owner', 'operator',
      '--runner', 'codex_goal',
      '--lane', 'business',
      '--verify', 'atris business check',
      '--stop', 'first proof recap recorded',
      '--json',
    ], { cwd: dir });
    assert.equal(mission.status, 0, mission.stderr || mission.stdout);
    const missionPayload = JSON.parse(mission.stdout);

    const goal = runCli(['member', 'goal-from-mission', 'operator', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
	    const goalPayload = JSON.parse(goal.stdout);
	    assert.equal(goalPayload.goal.mission_id, missionPayload.mission.id);
	    const ack = runCli([
	      'mission', 'goal', 'ack', missionPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Run the first useful loop for Loop Co',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const tick = runCli(['mission', 'tick', missionPayload.mission.id, '--verify', '--json', '--full'], {
      cwd: dir,
      env: { PATH: path.dirname(process.execPath) },
    });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.verifier_result.passed, true);

    fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-loop.md'), '# First Loop\n\nProof recap recorded.\n', 'utf8');
    const record = runCli(['business', 'record', 'atris/reports/first-loop.md', '--outcome', 'positive', '--metric', 'first loop'], { cwd: dir });
    assert.equal(record.status, 0, record.stderr || record.stdout);

    const share = runCli(['business', 'share', '--role', 'operator', '--name', 'Liv Loop', '--email', 'liv@loop.co', '--write'], { cwd: dir });
    assert.equal(share.status, 0, share.stderr || share.stdout);
    assert.match(share.stdout, /Ready to share: yes/);
    assert.match(share.stdout, /Tasks: 0 open, 1 claimed, 0 review \(0 certified\), 0 blocked/);
    assert.match(share.stdout, /Missions: 1 active, 0 running, 0 always-on, 0 stale\/no-verifier/);
    assert.match(share.stdout, /Team goals: 6 member lanes, 1 with active goals/);
    assert.match(share.stdout, /Loop: 1 mission ticks; Codex goal .*Run the first useful loop for Loop Co/);
    assert.match(share.stdout, /Events: 1/);
    assert.match(share.stdout, /Scorecards: 1/);
    assert.match(share.stdout, /atris task next/);
    assert.match(share.stdout, /atris mission start "Run the first useful loop for Loop Co"/);
    assert.match(share.stdout, /atris member goal-from-mission operator/);

    const handoffPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-share-operator.md`);
    const handoff = fs.readFileSync(handoffPath, 'utf8');
    assert.match(handoff, /For: Liv Loop <liv@loop\.co>/);
    assert.match(handoff, /atris business record atris\/reports\/<recap>\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business check names missing readiness for a received bare workspace', () => {
  const dir = makeTempDir();
  const outside = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-check',
      workspace_id: 'ws-check',
      name: 'Check Co',
      slug: 'check-co',
      owner_email: 'team@check.co',
      workspace_template: 'business',
    }, { here: true });

    const res = runCli(['business', 'check', '--cwd', dir, '--account'], { cwd: outside });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Check Co collaborator start/);
    assert.match(res.stdout, /Ready: no/);
    assert.match(res.stdout, /missing starter brief/);
    assert.match(res.stdout, /Add starter brief/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(outside);
  }
});


test('business share surfaces missing readiness in a fresh workspace', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-bare',
      workspace_id: 'ws-bare',
      name: 'Bare Co',
      slug: 'bare-co',
      owner_email: 'team@bare.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    let state;
    process.chdir(dir);
    try {
      state = await shareBusinessWorkspace('--role', 'validator');
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(state.ready, false);
    assert.ok(state.missing.includes('starter brief'));
    assert.ok(state.missing.includes('first loop'));
    assert.ok(state.missing.includes('operator one-pager'));
    assert.ok(state.missing.includes('first proof recap'));
  } finally {
    cleanupTempDir(dir);
  }
});


test('business share surfaces missing root agent adapters for older workspaces', async () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-old',
      workspace_id: 'ws-old',
      name: 'Old Co',
      slug: 'old-co',
      owner_email: 'team@old.co',
      workspace_template: 'business',
    }, { here: true });

    const prevCwd = process.cwd();
    let state;
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--website', 'https://old.co',
        '--contact', 'Ola Old',
        '--email', 'ola@old.co',
        '--note', 'Older shared folder missing root adapters'
      );
      fs.writeFileSync(path.join(dir, 'atris', 'reports', 'first-recap.md'), '# First Recap\n\nUseful loop happened.\n', 'utf8');
      await recordBusinessRun('atris/reports/first-recap.md', '--outcome', 'positive', '--metric', 'first loop');
      fs.rmSync(path.join(dir, 'AGENTS.md'), { force: true });
      fs.rmSync(path.join(dir, 'CLAUDE.md'), { force: true });
      fs.rmSync(path.join(dir, 'GEMINI.md'), { force: true });
      state = await shareBusinessWorkspace('--role', 'operator');
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(state.ready, false);
    assert.ok(state.missing.includes('root agent adapters'));
    assert.deepEqual(state.missingRootAgentAdapters, ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);

    const start = runCli(['business', 'start'], { cwd: dir });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    assert.match(start.stdout, /missing root agent adapters/);
    assert.match(start.stdout, /Run `atris update` to restore root AGENTS\.md, CLAUDE\.md, and GEMINI\.md adapters\./);

    const share = runCli(['business', 'share', '--role', 'operator'], { cwd: dir });
    assert.equal(share.status, 0, share.stderr || share.stdout);
    assert.match(share.stdout, /Agent setup: missing root agent adapters/);
    assert.match(share.stdout, /Run `atris update` to restore root AGENTS\.md, CLAUDE\.md, and GEMINI\.md adapters\./);
  } finally {
    cleanupTempDir(dir);
  }
});


test('business share is honest for local-only workspaces without cloud ids', async () => {
  const dir = makeTempDir();
  try {
    const prevCwd = process.cwd();
    let state;
    process.chdir(dir);
    try {
      await onboardBusiness(
        '--name', 'Local Only Co',
        '--website', 'https://local-only.example',
        '--contact', 'Local Owner',
        '--note', 'local workspace first'
      );
      await shareBusinessWorkspace('--role', 'operator', '--write');
      state = collectBusinessShareState(dir);
    } finally {
      process.chdir(prevCwd);
    }

    assert.equal(state.remoteReady, false);
    const handoffPath = path.join(dir, 'atris', 'reports', `${new Date().toISOString().slice(0, 10)}-share-operator.md`);
    const body = fs.readFileSync(handoffPath, 'utf8');
    assert.match(body, /Remote pull: local-only/);
    assert.match(body, /Remote pull is not available yet/);
    assert.match(body, /missing a cloud business ID or workspace ID/);
    assert.doesNotMatch(body, /atris pull local-only-co/);

    const res = runCli(['business', 'start'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Remote pull: local-only/);
    assert.match(res.stdout, /local-only: no cloud sync is available yet/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// receipt
// ============================================

test('receipt doctor prints readiness without requiring auth', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['receipt', 'doctor'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Receipt check/);
    assert.match(res.stdout, /business binding/);
    assert.match(res.stdout, /atris receipt init business-workflow/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('receipt init scaffolds task and receipt directory', () => {
  const dir = makeTempDir();
  try {
    createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-receipt',
      workspace_id: 'ws-receipt',
      name: 'Receipt Co',
      slug: 'receipt-co',
      owner_email: 'team@receipt.dev',
      workspace_template: 'business',
    }, { here: true });

    const res = runCli(['receipt', 'init', 'support-agent'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Receipt task ready/);

    const taskPath = path.join(dir, '.atris', 'tasks', 'support-agent.json');
    assert.ok(fs.existsSync(taskPath));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'receipts', '.gitkeep')));

    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assert.equal(task.workspace.slug, 'receipt-co');
    assert.equal(task.runtime.proof_command, 'atris computer proof');
  } finally {
    cleanupTempDir(dir);
  }
});


test('receipt run dry-run prints commands and writes nothing', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['receipt', 'run', '--dry-run'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris computer proof/);
    assert.match(res.stdout, /atris experiments replay endstate/);
    assert.match(res.stdout, /Dry run only/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'receipts')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// computer
// ============================================

test('computer card prints local workspace card without auth', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-workspace', bin: { demo: 'bin/demo.js' }, scripts: { test: 'node --test' } }, null, 2),
      'utf8'
    );
    initWorkspace(dir);

    const res = runCli(['computer', 'card'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Computer Card/);
    assert.match(res.stdout, /Owner:\s+demo-workspace \(project\)/);
    assert.match(res.stdout, /Type:\s+codeops/);
    assert.match(res.stdout, /Memory:\s+atris\/MAP\.md/);
    assert.match(res.stdout, /Validate:\s+npm test/);
    assert.doesNotMatch(res.stderr, /Not logged in/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('computer card --write saves an inspectable markdown artifact', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const res = runCli(['computer', 'card', '--write'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wrote atris\/reports\/computer-card\.md/);

    const cardPath = path.join(dir, 'atris', 'reports', 'computer-card.md');
    assert.ok(fs.existsSync(cardPath));
    const card = fs.readFileSync(cardPath, 'utf8');
    assert.match(card, /^# Atris Computer Card/);
    assert.match(card, /- Loop: plan -> do -> review/);
    assert.match(card, /- Proof: atris proof run/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('proof remains a quiet alias for receipt', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['proof', 'doctor'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Receipt check/);
  } finally {
    cleanupTempDir(dir);
  }
});


// research CLI command not yet wired — template exists but no `atris research` subcommand

// ============================================
// log sequential IDs
// ============================================

test('log assigns sequential IDs across sessions', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['log'], { cwd: dir, input: 'First idea\nexit\n' });
    runCli(['log'], { cwd: dir, input: 'Second idea\nexit\n' });

    const logsDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logsDir).filter(d => /^\d{4}$/.test(d));
    const yearDir = path.join(logsDir, yearDirs[0]);
    const logFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));
    const content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');

    assert.match(content, /I1/);
    assert.match(content, /I2/);
    assert.match(content, /First idea/);
    assert.match(content, /Second idea/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// status full mode
// ============================================

test('status default mode renders human summary', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Implement feature X',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '(Empty)',
    ].join('\n'), 'utf8');
    writeLiveMission(dir);

    const res = runCli(['status'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Where we are:/);
    assert.match(res.stdout, /What is queued:/);
    assert.match(res.stdout, /What is blocking:/);
    assert.doesNotMatch(res.stdout, /TASK BOARD|┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('status counts completed tasks from db without task db todo shim flag', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '(Empty)',
    ].join('\n'), 'utf8');

    const db = taskStore.open(dbPath);
    const workspaceRoot = taskStore.workspaceRoot(dir);
    const created = taskStore.addTask(db, {
      title: 'Accepted task should count in status',
      tag: 'status',
      workspaceRoot,
    });
    const done = taskStore.doneTask(db, {
      id: created.id,
      status: 'done',
      actor: 'keshavrao',
      proof: 'status db count test passed',
    });
    assert.equal(done.updated, true);
    taskStore.close();
    fs.chmodSync(dbPath, 0o444);

    const res = runCli(['status'], { cwd: dir, env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0 tasks in progress, 0 queued, and 1 completed items still\s+sitting in TODO\./);
  } finally {
    taskStore.close();
    cleanupTempDir(dir);
  }
});


test('task accept refreshes existing rendered todo view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '(Empty)',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '(Empty)',
    ].join('\n'), 'utf8');

    const add = runCli(['task', 'add', 'Refresh todo after accept', '--tag', 'status', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    const ready = runCli([
      'task',
      'ready',
      ref,
      '--as',
      'codex',
      '--proof',
      'todo refresh accept test passed',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);

    const { parseTodoFile } = require('../lib/todo-fallback');
    const parsed = parseTodoFile(todoPath);
    assert.equal(parsed.completed.length, 1);
    assert.equal(parsed.completed[0].title, 'Refresh todo after accept');
  } finally {
    cleanupTempDir(dir);
  }
});


test('status verbose mode keeps the legacy task board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['status', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK BOARD|Backlog/i);
    assert.match(res.stdout, /┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('status stays local even when .atris/business.json exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const metaDir = path.join(dir, '.atris');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'business.json'),
      JSON.stringify({ slug: 'example-co' }, null, 2),
      'utf8'
    );

    const res = runCli(['status'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ready to claim/);
    assert.match(res.stdout, /^next: atris task claim /m);
    assert.doesNotMatch(res.stdout, /last synced/i);
    assert.doesNotMatch(res.stdout, /Where we are|Decision: let it run/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('review default mode leads with certified accept like first-minute', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    initWorkspace(dir);
    const created = runCli(['task', 'new', 'Ship reviewed operator checkpoint', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const ref = task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const proof = `${'context '.repeat(35)}Verifiers: node --check test/commands.test.js passed, live atris review showed certified queue`;
    assert.equal(runCli(['task', 'ready', ref, '--proof', proof, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'review', ref, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);

    const res = runCli(['review'], { cwd: dir, env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /is waiting for your ok\./);
    assert.match(res.stdout, new RegExp(`^next: atris task accept ${ref}$`, 'm'));
    assert.doesNotMatch(res.stdout, /Atris Review is the human checkpoint/);
    assert.doesNotMatch(res.stdout, /Need the legacy Validator prompt/);
    assert.doesNotMatch(res.stdout, /I checked the review setup\./);
    assert.doesNotMatch(res.stdout, /┌|└|│|Validator Agent Activated/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('review verbose mode keeps the legacy validator board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['review', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Review|Validator Agent Activated/);
    assert.match(res.stdout, /Confirm active task state is clean/);
    assert.doesNotMatch(res.stdout, /delete completed tasks|DELETE completed tasks/);
    assert.match(res.stdout, /┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// feedback
// ============================================

test('feedback rejects unknown subcommands before submit fallback', () => {
  const dir = makeTempDir();
  try {
    const bogus = runCli(['feedback', 'bogus-subcommand', '--account'], { cwd: dir });
    assert.notEqual(bogus.status, 0);
    assert.match(bogus.stderr, /Unknown feedback command: bogus-subcommand/);
    assert.match(bogus.stderr, /Usage:/);
    assert.doesNotMatch(bogus.stdout, /Feedback submitted/);

    const show = runCli(['feedback', 'show', '0e136c15', '--account'], { cwd: dir });
    assert.notEqual(show.status, 0);
    assert.match(show.stderr, /Unknown feedback command: show/);
    assert.match(show.stderr, /Usage:/);
    assert.doesNotMatch(show.stdout, /Feedback submitted/);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// unknown command warning
// ============================================

test('casual launch words route to the durable mission loop', () => {
  const dir = makeTempDir();
  try {
    for (const args of [
      ['start', '--json', '--yes'],
      ['go', '--json', '--yes'],
    ]) {
      const res = runCli(args, { cwd: dir });
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}\n${res.stderr}`);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.ok, false);
      assert.doesNotMatch(res.stdout, /start_mission_run|mission_started|COPY\/PASTE PROMPT/i);
    }

    const keep = runCli(['keep', 'going', '--json', '--yes'], { cwd: dir });
    assert.notEqual(keep.status, 0, keep.stdout + keep.stderr);
    assert.doesNotMatch(keep.stdout, /start_mission_run|mission_started/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('unknown single-word command exits 2 without creating work', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
    const beforeTodo = fs.existsSync(path.join(dir, 'atris', 'TODO.md'))
      ? fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8')
      : null;
    const res = runCli(['foobarxyz'], { cwd: dir });
    assert.equal(res.status, 2, res.stderr || res.stdout);
    assert.match(res.stderr + res.stdout, /Unknown command.*foobarxyz/i);
    assert.doesNotMatch(res.stderr + res.stdout, /Treating as natural language/i);
    const afterTodo = fs.existsSync(path.join(dir, 'atris', 'TODO.md'))
      ? fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8')
      : null;
    assert.equal(afterTodo, beforeTodo);
  } finally {
    cleanupTempDir(dir);
  }
});


test('unknown top-level command with --json returns JSON error', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['foobarxyz', '--json'], { cwd: dir });
    assert.equal(res.status, 2, res.stderr);
    assert.equal(res.stderr, '');
    assert.deepEqual(JSON.parse(res.stdout), {
      ok: false,
      error: 'unknown command: foobarxyz',
      command: 'foobarxyz',
      input: 'foobarxyz --json',
      suggestions: [],
      usage: 'atris help',
    });
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// wiki
// ============================================

test('wiki help paths print usage without scaffolding workspace state', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const cases = [
      { args: ['ingest', '--help'], usage: /Usage: atris ingest/ },
      { args: ['query', '--help'], usage: /Usage: atris query/ },
      { args: ['lint', '--help'], usage: /Usage: atris lint/ },
      { args: ['wiki', '--help'], usage: /Usage: atris wiki/ },
      { args: ['wiki', 'ingest', '--help'], usage: /Usage: atris wiki ingest/ },
    ];

    for (const item of cases) {
      const res = runCli(item.args, { cwd: dir, env: { HOME: home } });
      assert.equal(res.status, 0, `${item.args.join(' ')}: ${res.stderr || res.stdout}`);
      assert.match(res.stdout, item.usage);
      assert.doesNotMatch(res.stdout, /Local wiki ingest|Local wiki query|Local wiki lint|No local wiki|Target: atris\/wiki|Prompt for/);
      assert.equal(fs.existsSync(path.join(dir, 'atris')), false, `${item.args.join(' ')} created atris/`);
      assert.equal(fs.existsSync(path.join(home, '.atris')), false, `${item.args.join(' ')} created ~/.atris`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('ingest is local-first and scaffolds atris/wiki', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Test source\n', 'utf8');
    const res = runCli(['ingest', 'README.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local wiki ingest/);
    assert.match(res.stdout, /Target: atris\/wiki/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'wiki.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'index.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'context', 'README.md')));
  } finally {
    cleanupTempDir(dir);
  }
});


test('local ingest stages a source pack and refreshes wiki bookkeeping', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sources', 'overview.md'), '# Overview\n', 'utf8');

    const res = runCli(['ingest', 'sources'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Pack: atris\/context\/_ingest\//);
    assert.match(res.stdout, /Manifest: atris\/context\/_ingest\//);
    assert.match(res.stdout, /Sources: atris\/context\/_ingest\//);

    const ingestRoot = path.join(dir, 'atris', 'context', '_ingest');
    const packs = fs.readdirSync(ingestRoot);
    assert.equal(packs.length, 1);

    const packDir = path.join(ingestRoot, packs[0]);
    const manifestPath = path.join(packDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.entries[0].kind, 'directory');
    assert.ok(manifest.entries[0].files.some((file) => file.endsWith('overview.md')));

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /Last ingest: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(status, /Health: ingest staged from atris\/context\/_ingest\//);
    assert.match(status, /Next move: compile atris\/context\/_ingest\//);

    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /INGEST 1 source item\(s\) staged from sources/);
    assert.match(log, /manifest atris\/context\/_ingest\//);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki ingest --private scaffolds .atris/presidio', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Private source\n', 'utf8');
    const res = runCli(['wiki', 'ingest', '--private', 'README.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Private wiki ingest/);
    assert.match(res.stdout, /Target: \.atris\/presidio/);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'wiki.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'index.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'STATUS.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'context', 'README.md')));
  } finally {
    cleanupTempDir(dir);
  }
});


test('query alias uses local wiki by default', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Atris Wiki Index\n', 'utf8');
    const res = runCli(['query', 'what is the system state'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local wiki query/);
    assert.match(res.stdout, /what is the system state/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki search reads canonical atris/wiki index', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'index.md'),
      '# Atris Wiki Index\n\n## Concepts\n\n- [[atris/wiki/concepts/local-first.md]] - local-first wiki routing\n',
      'utf8'
    );
    const res = runCli(['wiki', 'search', 'local-first'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /local-first wiki routing/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki log reads canonical atris/wiki log', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'log.md'),
      '# Atris Wiki Log\n\n## 2026-04-07\n- 10:00 INGEST README.md\n  - created local-first page\n',
      'utf8'
    );
    const res = runCli(['wiki', 'log'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2026-04-07/);
    assert.match(res.stdout, /INGEST README\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki sync alias normalizes --only wiki to atris/wiki', () => {
  assert.equal(normalizeWikiOnlyPrefix('wiki'), 'atris/wiki/');
  assert.equal(normalizeWikiOnlyPrefix('wiki/'), 'atris/wiki/');
  assert.equal(normalizeWikiOnlyPrefix('atris/wiki'), 'atris/wiki/');
});


test('agent-readable wiki contract requires sources, verification, dependencies, confidence, and actionability', () => {
  const dir = makeTempDir();
  try {
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'concepts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# Source\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'concepts', 'good.md'),
      [
        '---',
        'sources:',
        '  - README.md',
        `last_compiled: ${today}`,
        `last_verified: ${today}`,
        'confidence: 0.8',
        'dependencies: []',
        'actionability: "use this in weekly review"',
        '---',
        '# Good',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.deepEqual(validateAgentReadableWikiPages(dir).findings, []);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'concepts', 'bad.md'), '# Bad\n', 'utf8');
    const report = validateAgentReadableWikiPages(dir);
    assert.equal(report.ok, false);
    assert.equal(report.findings.some((finding) => finding.page.endsWith('bad.md') && finding.code === 'missing-sources'), true);
    assert.equal(report.findings.some((finding) => finding.page.endsWith('bad.md') && finding.code === 'missing-actionability'), true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki stale checks accept external source labels and legacy context paths', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'context', 'calls'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'context', 'calls', 'README.md'), '# Calls\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'systems'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'systems', 'example-co.md'),
      [
        '---',
        'sources: [hubspot, chorus, context/calls]',
        'last_compiled: 2999-01-01',
        'last_verified: 2999-01-01',
        'confidence: 0.7',
        'dependencies: []',
        'actionability: "route account questions"',
        '---',
        '# ExampleCo',
        '',
      ].join('\n'),
      'utf8'
    );

    assert.deepEqual(validateAgentReadableWikiPages(dir).findings, []);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki orphan checks accept markdown links in legacy indexes', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'index.md'),
      '# Index\n\n- [Jane](people/jane.md)\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'people', 'jane.md'),
      [
        '---',
        'sources: [hubspot]',
        'last_compiled: 2999-01-01',
        'last_verified: 2999-01-01',
        'confidence: 0.7',
        'dependencies: []',
        'actionability: "route stakeholder questions"',
        '---',
        '# Jane',
        '',
      ].join('\n'),
      'utf8'
    );

    const { findWikiOrphans } = require('../lib/wiki');
    assert.deepEqual(findWikiOrphans(dir), []);
  } finally {
    cleanupTempDir(dir);
  }
});


test('loop flags stale wiki pages and refreshes status/log', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const pagePath = path.join(dir, 'atris', 'wiki', 'concepts', 'stale-page.md');
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });
    fs.writeFileSync(pagePath, [
      '---',
      'type: concept',
      'slug: stale-page',
      'title: Stale Page',
      'sources:',
      '  - README.md',
      'last_compiled: 2000-01-01',
      'created: 2000-01-01',
      'updated: 2000-01-01',
      'tags:',
      '  - test',
      '---',
      '# Stale Page',
      '',
      'Body.',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['loop', 'wiki'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
    assert.match(res.stdout, /Stale: 1/);

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /Last loop:/);
    assert.match(status, /recompile atris\/wiki\/concepts\/stale-page\.md from README\.md/);

    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /LOOP/);
    assert.match(log, /stale atris\/wiki\/concepts\/stale-page\.md <- README\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('loop suggests next ingest candidates when wiki is clean', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const res = runCli(['loop', 'wiki', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.ok(report.nextSources.includes('README.md'));
    assert.match(report.health, /ready for ingest|stable/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki loop alias runs the same upkeep analysis', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const res = runCli(['wiki', 'loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('getVerifyCommand finds task-specific verify commands before and after task moves', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** 2026-04-09 00:00
**Horizon:** Verify stays attached to the task.
**Source:** test

## Backlog
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

## In Progress

---

## Completed

---
`, 'utf8');

    const result1 = getVerifyCommand(dir, 'ship parser fix');
    assert.equal(result1.cmd, 'node -e "process.exit(0)"');
    assert.equal(result1.explicit, true);

    fs.writeFileSync(todoPath, `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** 2026-04-09 00:00
**Horizon:** Verify stays attached to the task.
**Source:** test

## Backlog

## In Progress

---

## Completed
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

---
`, 'utf8');

    const result2 = getVerifyCommand(dir, 'ship parser fix');
    assert.equal(result2.cmd, 'node -e "process.exit(0)"');
    assert.equal(result2.explicit, true);
  } finally {
    cleanupTempDir(dir);
  }
});


test('computeTickReward does not award verify points when review failed before verify ran', () => {
  const reward = computeTickReward({
    reviewOutput: 'failed — scope drift',
    verifyPass: false,
    verifyRan: false,
    phaseResults: {
      do: { output: '' }
    }
  }, 'halted', 'npm test');

  assert.equal(reward, -3);
});


test('REWARD_CONFIG is frozen and cannot be mutated', () => {
  assert.ok(Object.isFrozen(REWARD_CONFIG));
  assert.throws(() => { 'use strict'; REWARD_CONFIG.VERIFY_PASS = 999; }, TypeError);
});


test('REWARD_CHECKSUM matches live REWARD_CONFIG + computeTickReward source', () => {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(REWARD_CONFIG));
  h.update(computeTickReward.toString());
  const actual = h.digest('hex');
  assert.strictEqual(actual, REWARD_CHECKSUM);
});


test('verifyJudgeIntegrity returns ok:true on clean state', () => {
  const result = verifyJudgeIntegrity();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.expected, result.actual);
});


test('maybeWriteCompletedEndgameScorecard writes a scorecard from closed endgame state', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** ${dateStr} 00:00
**Horizon:** Every closed endgame writes a scorecard.
**Source:** test

## Backlog

## In Progress

---

## Completed
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

---
`, 'utf8');

    writeTodayLog(dir, `# Log — ${dateStr}

## Handoff

---

## Completed ✅

---

## In Progress 🔄

---

## Backlog

---

## Notes

### Endgame picked — 12:00 AM PDT

slug: verify-loop

- 12:10 am
  I planned, built, and reviewed "ship parser fix".
  We are still on the verify-loop endgame.
  Next tick will pick the next endgame task.
  Reward: 6

## Inbox

---
`);

    const wrote = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'verify-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });

    assert.equal(wrote, true);
    const scorecards = readScorecards(path.join(dir, 'atris'));
    assert.equal(scorecards.length, 1);
    assert.equal(scorecards[0].slug, 'verify-loop');
    assert.equal(scorecards[0].tasksShipped, 1);
    assert.equal(scorecards[0].totalReward, 6);

    const wroteAgain = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'verify-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });
    assert.equal(wroteAgain, false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('maybeWriteCompletedEndgameScorecard treats Review endgame work as active', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), `# TODO.md

## Endgame

**Slug:** review-loop
**Picked:** ${dateStr} 00:00
**Horizon:** Review is not shipped yet.
**Source:** test

## Backlog

(Empty)

## In Progress

(Empty)

## Review

- **[T1]** Waiting for human accept [endgame]
  **Verify:** node -e "process.exit(0)"

## Completed

(Empty)
`, 'utf8');

    const wrote = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'review-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });

    assert.equal(wrote, false);
    const scorecards = readScorecards(path.join(dir, 'atris'));
    assert.equal(scorecards.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});


// ============================================
// scoreEndgameCandidates
// ============================================

test('scoreEndgameCandidates returns best by confidence when no atris folder', () => {
  const dir = makeTempDir();
  try {
    const candidates = [
      { title: 'wiki-search', confidence: 0.9, rationale: 'High confidence' },
      { title: 'verify-tests', confidence: 0.7, rationale: 'Medium confidence' },
      { title: 'refactor-cli', confidence: 0.5, rationale: 'Low confidence' }
    ];
    const result = scoreEndgameCandidates(dir, candidates);
    assert.equal(result.title, 'wiki-search', 'should pick highest confidence');
    assert.equal(result.confidence, 0.9);
    assert.equal(result.scored, false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('scoreEndgameCandidates returns best by confidence when no scorecards', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const candidates = [
      { title: 'wiki-search', confidence: 0.6, rationale: 'Medium confidence' },
      { title: 'verify-tests', confidence: 0.8, rationale: 'High confidence' },
      { title: 'refactor-cli', confidence: 0.4, rationale: 'Low confidence' }
    ];
    const result = scoreEndgameCandidates(dir, candidates);
    assert.equal(result.title, 'verify-tests', 'should pick highest confidence');
    assert.equal(result.confidence, 0.8);
    assert.equal(result.scored, false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('scoreEndgameCandidates scores candidates by historical reward with adaptive explore rate', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // Create scorecards with diverse types (wiki, verify, refactor, harden)
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-search-v1** — shipped: 3/3 — wall-clock: 2.5h — halt: 10% — reward: 50 — lessons: 5
- **[2026-04-02] verify-tests** — shipped: 2/3 — wall-clock: 3.0h — halt: 20% — reward: 40 — lessons: 3
- **[2026-04-03] refactor-api** — shipped: 4/4 — wall-clock: 1.5h — halt: 5% — reward: 55 — lessons: 6
- **[2026-04-04] harden-loop** — shipped: 1/2 — wall-clock: 4.0h — halt: 30% — reward: 30 — lessons: 2
- **[2026-04-05] ship-release** — shipped: 2/2 — wall-clock: 1.0h — halt: 0% — reward: 45 — lessons: 1
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-new-feature', confidence: 0.7, rationale: 'New wiki work' },
      { title: 'verify-edge-cases', confidence: 0.6, rationale: 'Test edge cases' },
      { title: 'refactor-api', confidence: 0.8, rationale: 'Refactor API' }
    ];

    // 5 unique types in last 5 → exploreRate = 0.2 (max diversity)
    let exploitCount = 0, exploreCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      assert.equal(result.scored, true);
      assert.ok(result.reason, 'should have scoring reason');
      assert.ok(result.exploreRate !== undefined, 'should expose exploreRate');
      // With 5 unique types, exploreRate should be 0.2
      assert.ok(Math.abs(result.exploreRate - 0.2) < 0.01, `explore rate ${result.exploreRate} should be ~0.2`);
      if (result.reason.includes('exploit')) exploitCount++;
      else if (result.reason.includes('explore')) exploreCount++;
    }

    // ~80/20 split with diverse history
    assert.ok(exploitCount >= 60 && exploitCount <= 100, `exploit count ${exploitCount} should be ~80`);
    assert.ok(exploreCount >= 0 && exploreCount <= 40, `explore count ${exploreCount} should be ~20`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('scoreEndgameCandidates boosts explore to 50% when last 5 are same type', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // All 5 scorecards are wiki-* type
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-search** — shipped: 3/3 — wall-clock: 2.5h — halt: 10% — reward: 50 — lessons: 5
- **[2026-04-02] wiki-ingest** — shipped: 2/3 — wall-clock: 3.0h — halt: 20% — reward: 40 — lessons: 3
- **[2026-04-03] wiki-lint** — shipped: 4/4 — wall-clock: 1.5h — halt: 5% — reward: 55 — lessons: 6
- **[2026-04-04] wiki-status** — shipped: 3/3 — wall-clock: 2.0h — halt: 0% — reward: 45 — lessons: 2
- **[2026-04-05] wiki-compile** — shipped: 2/2 — wall-clock: 1.0h — halt: 0% — reward: 48 — lessons: 1
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-new-feature', confidence: 0.7, rationale: 'More wiki work' },
      { title: 'verify-edge-cases', confidence: 0.6, rationale: 'Test edge cases' },
      { title: 'refactor-api', confidence: 0.5, rationale: 'Refactor API' }
    ];

    let exploitCount = 0, exploreCount = 0;
    for (let i = 0; i < 200; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      assert.equal(result.scored, true);
      // All same type → exploreRate should be 0.5
      assert.ok(Math.abs(result.exploreRate - 0.5) < 0.01, `explore rate ${result.exploreRate} should be 0.5`);
      if (result.reason.includes('exploit')) exploitCount++;
      else if (result.reason.includes('explore')) exploreCount++;
    }

    // ~50/50 split: explore should be significantly higher than 20%
    assert.ok(exploreCount >= 60, `explore count ${exploreCount} should be >= 60 out of 200 (50% rate)`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('scoreEndgameCandidates filters easy-win candidates when harder ones exist', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // wiki type: high success rate (9/10 = 90%) and high mean reward (50)
    // verify type: low success rate (3/6 = 50%) and low mean reward (10)
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-a** — shipped: 3/3 — wall-clock: 1.0h — halt: 0% — reward: 50 — lessons: 2
- **[2026-04-02] verify-a** — shipped: 1/2 — wall-clock: 3.0h — halt: 30% — reward: 10 — lessons: 3
- **[2026-04-03] wiki-b** — shipped: 3/3 — wall-clock: 1.0h — halt: 0% — reward: 50 — lessons: 1
- **[2026-04-04] verify-b** — shipped: 1/2 — wall-clock: 4.0h — halt: 40% — reward: 10 — lessons: 4
- **[2026-04-05] wiki-c** — shipped: 3/4 — wall-clock: 1.5h — halt: 5% — reward: 50 — lessons: 2
- **[2026-04-06] verify-c** — shipped: 1/2 — wall-clock: 3.5h — halt: 35% — reward: 10 — lessons: 3
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-easy', confidence: 0.9, rationale: 'Easy wiki task' },
      { title: 'verify-hard', confidence: 0.7, rationale: 'Hard verify task' },
      { title: 'refactor-new', confidence: 0.5, rationale: 'New refactor work' }
    ];

    // Run many times — exploit picks should never be wiki-easy (filtered by difficulty floor)
    let wikiExploitCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      if (result.reason.includes('exploit') && result.title === 'wiki-easy') {
        wikiExploitCount++;
      }
    }

    // wiki type has >80% success rate and mean reward 50 (>5), so it should be filtered
    // from the exploit pool. Exploit picks should not select wiki-easy.
    assert.equal(wikiExploitCount, 0, 'easy-win wiki should be filtered from exploit pool');
  } finally {
    cleanupTempDir(dir);
  }
});


test('scoreEndgameCandidates returns fallback when scoring fails', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // Write malformed scorecards to trigger parsing error
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    fs.writeFileSync(scorecardsPath, '# scorecards\n\nmalformed line that won\'t parse', 'utf8');

    const candidates = [
      { title: 'wiki-work', confidence: 0.9, rationale: 'High confidence' },
      { title: 'verify-work', confidence: 0.5, rationale: 'Low confidence' }
    ];

    const result = scoreEndgameCandidates(dir, candidates);
    // Should fall back to best by confidence
    assert.equal(result.title, 'wiki-work');
    assert.equal(result.confidence, 0.9);
    // scored flag tells us it fell back (if there was an error)
  } finally {
    cleanupTempDir(dir);
  }
});


// ─── writeLesson ───────────────────────────────────────────

test('writeLesson appends a lesson line to existing lessons.md', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    const lessonsPath = path.join(atrisDir, 'lessons.md');
    fs.writeFileSync(lessonsPath, '# lessons.md — What We Learned\n\n> Append-only.\n\n---\n\n', 'utf8');

    const before = fs.readFileSync(lessonsPath, 'utf8').split('\n').length;
    writeLesson(dir, 'test-slug', 'fail', 'Test explanation');
    const after = fs.readFileSync(lessonsPath, 'utf8').split('\n').length;

    assert.ok(after > before, `Expected line count to grow: ${before} → ${after}`);
    const content = fs.readFileSync(lessonsPath, 'utf8');
    assert.ok(content.includes('test-slug'), 'Lesson should contain slug');
    assert.ok(content.includes('fail'), 'Lesson should contain status');
    assert.ok(content.includes('Test explanation'), 'Lesson should contain explanation');
  } finally {
    cleanupTempDir(dir);
  }
});


test('writeLesson creates lessons.md if it does not exist', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    writeLesson(dir, 'new-file-slug', 'pass', 'Created from scratch');

    const lessonsPath = path.join(atrisDir, 'lessons.md');
    assert.ok(fs.existsSync(lessonsPath), 'lessons.md should be created');
    const content = fs.readFileSync(lessonsPath, 'utf8');
    assert.ok(content.includes('new-file-slug'), 'Lesson should contain slug');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task lineage', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const parent = runCli(['task', 'new', 'Parent endgame task', '--json'], { cwd: dir, env });
    assert.equal(parent.status, 0, parent.stderr);
    const parentPayload = JSON.parse(parent.stdout);
    const parentRef = parentPayload.task.display_id;

    const child = runCli(['task', 'add', 'Child task under parent', '--goal-id', parentPayload.task_id, '--json'], { cwd: dir, env });
    assert.equal(child.status, 0, child.stderr);
    const childPayload = JSON.parse(child.stdout);
    const childRef = childPayload.task.display_id;

    const text = runCli(['task', 'lineage', childRef], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(parentRef));
    assert.match(text.stdout, new RegExp(childRef));

    const parentLine = text.stdout.split('\n').findIndex(l => l.includes(parentRef));
    const childLine = text.stdout.split('\n').findIndex(l => l.includes(childRef));
    assert.ok(parentLine < childLine, 'parent appears before child in text output');

    const json = runCli(['task', 'lineage', childRef, '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'lineage');
    assert.ok(payload.chain, 'chain present');
    assert.ok(payload.chain.target, 'target present');
    assert.equal(payload.chain.target.display_id, childRef);
    assert.ok(Array.isArray(payload.chain.commits), 'commits is an array');

    const noGitEnv = { ...env, HOME: dir };
    const noGit = runCli(['task', 'lineage', childRef], { cwd: dir, env: noGitEnv });
    assert.equal(noGit.status, 0, 'no crash without git');
  } finally {
    cleanupTempDir(dir);
  }
});
