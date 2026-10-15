const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const {
  branchName,
  cleanupWorktrees,
  createOrFindPr,
  defaultStartBase,
  normalizeTargetRef,
  parseWorktrees,
  slugify,
  swarloClaim,
  formatLocalDate,
  scrubAgentEnv,
  repoRoot,
  cliPath,
  makeTempDir,
  recentLogDate,
  recentLogYear,
  cleanupTempDir,
  runCli,
  fakeMemberRunClaude,
  makeFakeGh,
  seedSupervisorWakeFixture,
  runGit,
} = require('./helpers/commands-shared');

test('member create initializes MEMBER.md and dated logs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const res = runCli(['member', 'create', 'member-trainer', '--role="Member Trainer"', '--description="Trains teammates before autonomy"'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const memberPath = path.join(dir, 'atris', 'team', 'member-trainer', 'MEMBER.md');
    const missionPath = path.join(dir, 'atris', 'team', 'member-trainer', 'MISSION.md');
    const logsDir = path.join(dir, 'atris', 'team', 'member-trainer', 'logs');
    assert.ok(fs.existsSync(memberPath));
    assert.ok(fs.existsSync(missionPath));
    assert.match(fs.readFileSync(missionPath, 'utf8'), /# Mission/);
    assert.ok(fs.existsSync(logsDir));
    const logs = fs.readdirSync(logsDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
    assert.equal(logs.length, 1);
    const log = fs.readFileSync(path.join(logsDir, logs[0]), 'utf8');
    assert.match(log, /Member initialized/);
    assert.match(log, /Trains teammates before autonomy/);
    assert.match(res.stdout, /logs\/\d{4}-\d{2}-\d{2}\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member run allows an unchecked mission start', () => {
  const { buildMemberRunStartArgs } = require('../commands/member');
  const bare = buildMemberRunStartArgs('maze', 'choose useful work', ['--runner', 'atris2', '--minutes', '5']);
  assert.ok(bare.includes('--no-verify'), 'no verifier named → explicit --no-verify');
  const verified = buildMemberRunStartArgs('maze', 'ship X', ['--verify', 'npm test']);
  assert.ok(!verified.includes('--no-verify'), 'a named verifier is kept, not overridden');
  assert.ok(verified.includes('--verify') && verified.includes('npm test'));
  const explicit = buildMemberRunStartArgs('maze', 'explore', ['--no-verify']);
  assert.equal(explicit.filter((a) => a === '--no-verify').length, 1, 'explicit opt-out is passed once');
});


test('member run defaults to a worktree only inside a git repo', () => {
  // A plain (non-git) workspace cannot cut a worktree — every mission start
  // would die with "fatal: not a git repository". Degrade to shared checkout.
  const { buildMemberRunStartArgs } = require('../commands/member');
  const inRepo = buildMemberRunStartArgs('maze', 'work', [], __dirname);
  assert.ok(inRepo.includes('--worktree'), 'git repo → isolated worktree by default');
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-nogit-'));
  try {
    const noRepo = buildMemberRunStartArgs('maze', 'work', [], plainDir);
    assert.ok(!noRepo.includes('--worktree'), 'non-git workspace → shared checkout');
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});


test('member run starts a budgeted isolated mission from plain text', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-test-'));
  const dir = path.join(base, 'repo');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const git = (args, cwd = dir) => {
      const result = runGit(args, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const logDir = path.join(dir, 'atris', 'logs', today.slice(0, 4));
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `${today}.md`), [
      `# Log ${today}`,
      '',
      '## Inbox',
      '',
      '- **I1:** test idea',
      '',
    ].join('\n'), 'utf8');
    const created = runCli(['member', 'create', 'growth'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    fs.writeFileSync(path.join(dir, 'main-dirt.txt'), 'noise that must stay out of the member mission\n');
    const env = fakeMemberRunClaude(dir);

    const res = runCli([
      'member',
      'run',
      'growth',
      'Improve onboarding proof',
      '--minutes',
      '10',
      '--max-ticks',
      '1',
      '--no-verify',
      '--json',
    ], { cwd: dir, env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const mission = payload.mission;

    assert.equal(payload.started, true);
    assert.equal(payload.ran_ticks, 1);
    assert.equal(mission.owner, 'growth');
    assert.equal(mission.objective, 'Improve onboarding proof');
    // No live codex session drove this run, so the runner defaults to claude
    // (which drives itself headless) rather than codex_goal (which would stall
    // waiting for a native goal start that never comes).
    assert.equal(mission.runner, 'claude');
    assert.equal(mission.budget_contract.requested_seconds, 600);
    assert.equal(mission.max_wall_seconds, 600);
    assert.match(mission.stop_condition, /use the whole time unless blocked or unsafe/);
    assert.ok(mission.worktree?.path, 'member mission should have an isolated worktree by default');
    assert.ok(fs.existsSync(mission.worktree.path));
    assert.notEqual(fs.realpathSync(mission.worktree.path), fs.realpathSync(dir));
    assert.ok(!fs.existsSync(path.join(mission.worktree.path, 'main-dirt.txt')));
    assert.ok(fs.existsSync(path.join(mission.worktree.path, '.atris', 'state', 'missions.jsonl')));
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')), false);
  } finally {
    cleanupTempDir(base);
  }
});


test('member run chooses useful work from params when no mission text exists', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-run-auto-test-'));
  const dir = path.join(base, 'repo');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const git = (args, cwd = dir) => {
      const result = runGit(args, cwd);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['member', 'create', 'growth'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);
    const env = fakeMemberRunClaude(dir);

    const res = runCli([
      'member',
      'run',
      'growth',
      '--minutes',
      '5',
      '--industry',
      'logistics',
      '--value',
      'reduce support time',
      '--max-ticks',
      '1',
      '--no-verify',
      '--json',
    ], { cwd: dir, env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    const mission = payload.mission;

    assert.equal(payload.started, true);
    assert.equal(payload.ran_ticks, 1);
    assert.equal(mission.owner, 'growth');
    assert.match(mission.objective, /meaningful work for logistics/);
    assert.match(mission.objective, /reduce support time/);
    assert.match(mission.objective, /what changed, what was checked, and what is still unproven/);
    assert.match(mission.objective, /stop instead of doing fake busywork/);
    assert.doesNotMatch(mission.objective, /Start with this concrete candidate: test idea/);
    assert.equal(mission.budget_contract.requested_seconds, 300);
    assert.equal(mission.max_wall_seconds, 300);
    assert.ok(mission.worktree?.path, 'auto member mission should still use an isolated worktree');
  } finally {
    cleanupTempDir(base);
  }
});


test('harvest surfaces receipt and thinking actions, then writes inbox on request', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'thinking.md'), [
      '# thinking',
      '',
      '- Values plain English and proof over motion.',
      '- Stop instead of fake busywork when there is no concrete next move.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'mission-harvest.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-harvest',
      objective: 'harvest buried proof',
      result: {
        landing: {
          changed: 'Saved a useful receipt.',
          reason: 'The good reasoning was buried in a receipt.',
          checked: 'I checked the receipt.',
          tested: 'No automated verifier ran for this receipt.',
          proof: 'Receipt saved at atris/runs/mission-harvest.json.',
          next: 'no concrete follow-up mission found in Atris state',
        },
        verifier_result: { passed: true },
      },
    }, null, 2), 'utf8');

    const help = runCli(['harvest', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris harvest/);

    const readOnly = runCli(['harvest', '--json'], { cwd: dir });
    assert.equal(readOnly.status, 0, readOnly.stderr || readOnly.stdout);
    const payload = JSON.parse(readOnly.stdout);
    assert.equal(payload.action, 'harvest');
    assert.equal(payload.write, false);
    assert.ok(payload.actions.some((action) => /Surface buried result landing/.test(action.title)));
    assert.ok(payload.actions.some((action) => /proof and task previews plain/.test(action.title)));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'logs')), false);

    const written = runCli(['harvest', '--write', '--json'], { cwd: dir });
    assert.equal(written.status, 0, written.stderr || written.stdout);
    const writtenPayload = JSON.parse(written.stdout);
    assert.ok(writtenPayload.writes.some((item) => item.line));
    const today = new Date();
    const logPath = path.join(
      dir,
      'atris',
      'logs',
      String(today.getFullYear()),
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`,
    );
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /Surface buried result landing reasoning/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('worktree helpers keep member identity in branch and parse git worktrees', () => {
  assert.equal(slugify('Security Agent!!'), 'security-agent');
  assert.equal(
    branchName('security', 'OAuth timeout hardening', new Date('2026-05-11T08:09:10Z')),
    'codex/security-oauth-timeout-hardening-20260511-080910'
  );

  const parsed = parseWorktrees(`
worktree /repo/main
HEAD abc123
branch refs/heads/main

worktree /repo/.agent-worktrees/security
HEAD def456
branch refs/heads/codex/security-task
`);
  assert.deepEqual(parsed, [
    { path: '/repo/main', branch: 'main', head: 'abc123' },
    { path: '/repo/.agent-worktrees/security', branch: 'codex/security-task', head: 'def456' },
  ]);
});


test('worktree swarlo claim is best-effort when local bridge is absent', () => {
  const dir = makeTempDir();
  try {
    assert.equal(
      swarloClaim(dir, { channel: 'general', taskKey: 'security-task', content: 'security owns task' }),
      'skip: scripts/swarlo.py not found'
    );
  } finally {
    cleanupTempDir(dir);
  }
});


test('worktree guide prints the agent mission ship recipe', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['worktree', 'guide'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris worktree agent recipe/);
    assert.match(res.stdout, /Default: stay in the current checkout/);
    assert.match(res.stdout, /atris mission start/);
    assert.match(res.stdout, /atris member goal-from-mission/);
    assert.match(res.stdout, /atris worktree ship --message/);
    assert.match(res.stdout, /atris worktree cleanup --apply/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('worktree cleanup removes only clean merged sibling worktrees', () => {
  const dir = makeTempDir();
  let cleanWorktree;
  let dirtyWorktree;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    cleanWorktree = path.join(dir, '..', `${path.basename(dir)}-clean-worktree`);
    dirtyWorktree = path.join(dir, '..', `${path.basename(dir)}-dirty-worktree`);
    runGit(['worktree', 'add', '-q', '-b', 'clean-done', cleanWorktree, 'HEAD']);
    runGit(['worktree', 'add', '-q', '-b', 'dirty-done', dirtyWorktree, 'HEAD']);
    fs.writeFileSync(path.join(dirtyWorktree, 'dirty.txt'), 'keep me\n');
    // age both past the fresh-worktree grace window so cleanup may consider them
    const staleStamp = new Date(Date.now() - 61 * 60 * 1000);
    fs.utimesSync(cleanWorktree, staleStamp, staleStamp);
    fs.utimesSync(dirtyWorktree, staleStamp, staleStamp);

    const dryRun = cleanupWorktrees({ root: dir, base: 'HEAD' });
    assert.deepEqual(dryRun.candidates.map(item => fs.realpathSync(item.path)), [fs.realpathSync(cleanWorktree)]);
    assert(dryRun.kept.some(item => fs.realpathSync(item.path) === fs.realpathSync(dirtyWorktree) && item.reason === 'dirty'));
    const cleanCandidatePath = dryRun.candidates[0].path;

    const applied = cleanupWorktrees({ root: dir, base: 'HEAD', apply: true });
    assert.deepEqual(applied.removed.map(item => item.path), [cleanCandidatePath]);
    assert.equal(fs.existsSync(cleanWorktree), false);
    assert.equal(fs.existsSync(dirtyWorktree), true);
  } finally {
    if (dirtyWorktree) spawnSync('git', ['worktree', 'remove', '--force', dirtyWorktree], { cwd: dir, encoding: 'utf8' });
    if (cleanWorktree) spawnSync('git', ['worktree', 'remove', '--force', cleanWorktree], { cwd: dir, encoding: 'utf8' });
    cleanupTempDir(dir);
  }
});


test('worktree start creates a member-scoped isolated checkout', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'security'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'security', 'MEMBER.md'), '# Security\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-security-worktree`);
    const res = runCli([
      'worktree',
      'start',
      '--member',
      'security',
      '--task',
      'Smoke Task',
      '--path',
      worktreePath,
    ], { cwd: dir });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, new RegExp(`path: ${worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.existsSync(path.join(worktreePath, 'atris', 'team', 'security', 'MEMBER.md')), true);
    assert.match(runGit(['branch', '--show-current'], worktreePath), /^codex\/security-smoke-task-/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('worktree start supports generic subagent checkout without a member persona', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-subagent-worktree`);
    const res = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-reviewer',
      '--task',
      'Smoke Task',
      '--path',
      worktreePath,
    ], { cwd: dir });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /agent: codex-reviewer/);
    assert.doesNotMatch(res.stderr, /no member persona/);
    assert.equal(fs.existsSync(path.join(worktreePath, 'README.md')), true);
    assert.match(runGit(['branch', '--show-current'], worktreePath), /^codex\/codex-reviewer-smoke-task-/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('legacy agent_worktree.py create command maps to atris worktree start', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);

    worktreePath = path.join(dir, '..', `${path.basename(dir)}-legacy-script-worktree`);
    const res = spawnSync('python3', [
      path.join(repoRoot, 'scripts', 'agent_worktree.py'),
      'create',
      '--agent',
      'codex-reviewer',
      '--task',
      'Smoke Task',
      '--base',
      'HEAD',
      '--path',
      worktreePath,
    ], { cwd: dir, encoding: 'utf8', env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' } });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /compat: scripts\/agent_worktree\.py maps to:/);
    assert.match(res.stdout, /atris worktree start --agent codex-reviewer --task Smoke Task --base HEAD/);
    assert.match(res.stdout, new RegExp(`path: ${worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.existsSync(path.join(worktreePath, 'README.md')), true);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('worktree start defaults to upstream remote base and records ship metadata', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    assert.equal(defaultStartBase(repo), 'origin/master');
    assert.equal(normalizeTargetRef(repo, 'master'), 'origin/master');
    worktreePath = path.join(dir, 'agent-worktree');
    const res = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Smoke',
      '--path',
      worktreePath,
    ], { cwd: repo });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /base: origin\/master/);
    const branch = runGit(['branch', '--show-current'], worktreePath);
    assert.match(branch, /^codex\/codex-shipper-ship-smoke-/);
    assert.equal(runGit(['config', '--get', `branch.${branch}.atris-base`], worktreePath), 'origin/master');
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('worktree start isolates agent/member worktrees on origin/master when the launcher is on a feature branch', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    // The launcher checkout is on its own feature branch, tracking that
    // branch on origin: the exact live shape that false-landed two PRs.
    runGit(['checkout', '-qb', 'task/feature-work']);
    fs.appendFileSync(path.join(repo, 'README.md'), 'feature work in progress\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'feature work']);
    runGit(['push', '-u', 'origin', 'task/feature-work']);

    assert.equal(defaultStartBase(repo), 'origin/task/feature-work', 'sanity: launcher upstream is the feature branch');

    worktreePath = path.join(dir, 'agent-worktree');
    const res = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Smoke',
      '--path',
      worktreePath,
    ], { cwd: repo });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /base: origin\/master/, 'ship target must default to master, not the launcher branch');
    const branch = runGit(['branch', '--show-current'], worktreePath);
    assert.equal(runGit(['config', '--get', `branch.${branch}.atris-base`], worktreePath), 'origin/master');
    // The checkout point must not inherit the launcher's feature commit. A
    // parallel session's in-progress branch is not a safe worker base.
    assert.match(runGit(['log', '-1', '--oneline'], worktreePath), /init/);
    assert.doesNotMatch(runGit(['show', 'HEAD:README.md'], worktreePath), /feature work in progress/);

    const sidecar = JSON.parse(fs.readFileSync(path.join(worktreePath, '.atris', 'agent-worktree.json'), 'utf8'));
    assert.equal(sidecar.base, 'origin/master');
    assert.equal(sidecar.checkout_base, 'origin/master');
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('worktree start honors an explicit --target for both the checkout point and the ship target', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
    runGit(['checkout', '-qb', 'release/cut']);
    runGit(['push', '-u', 'origin', 'release/cut']);

    worktreePath = path.join(dir, 'agent-worktree');
    const res = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Smoke',
      '--path',
      worktreePath,
      '--target',
      'release/cut',
    ], { cwd: repo });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /base: origin\/release\/cut/, '--target overrides the ship target too');
    const branch = runGit(['branch', '--show-current'], worktreePath);
    assert.equal(runGit(['config', '--get', `branch.${branch}.atris-base`], worktreePath), 'origin/release/cut');
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('worktree ship commits verifies and pushes an isolated branch', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    worktreePath = path.join(dir, 'ship-worktree');
    const start = runCli([
      'worktree',
      'start',
      '--agent',
      'codex-shipper',
      '--task',
      'Ship Smoke',
      '--path',
      worktreePath,
    ], { cwd: repo });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');

    const shipped = runCli([
      'worktree',
      'ship',
      '--message',
      'ship smoke',
      '--verify',
      'git status --short',
      '--no-pr',
    ], { cwd: worktreePath });

    assert.equal(shipped.status, 0, shipped.stderr || shipped.stdout);
    assert.match(shipped.stdout, /merge_check: origin\/master clean/);
    assert.match(shipped.stdout, /pr: skipped \(\-\-no-pr\)/);
    assert.match(shipped.stdout, /done: worktree shipped/);
    const branch = runGit(['branch', '--show-current'], worktreePath);
    assert.match(
      runGit(['--git-dir', remote, 'show-ref', '--verify', `refs/heads/${branch}`], dir),
      new RegExp(`refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    );
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('createOrFindPr ignores a stale MERGED pr for this branch and opens a fresh one', () => {
  const dir = makeTempDir();
  try {
    const binDir = makeFakeGh(dir, { viewState: 'MERGED', viewNumber: 42, createNumber: 99 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath}`;
    try {
      const pr = createOrFindPr(dir, 'codex/reused-branch', 'origin/master', 'reused branch title', false);
      assert.match(pr, /pull\/99/, 'a merged PR must never be reused; a fresh one must be created');
      assert.doesNotMatch(pr, /pull\/42/);
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('createOrFindPr reuses a real OPEN pr for this branch instead of opening a duplicate', () => {
  const dir = makeTempDir();
  try {
    const binDir = makeFakeGh(dir, { viewState: 'OPEN', viewNumber: 7 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath}`;
    try {
      const pr = createOrFindPr(dir, 'codex/open-branch', 'origin/master', 'open branch title', false);
      assert.match(pr, /pull\/7/);
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('worktree ship refuses to report success when gh pr merge silently no-ops an already-merged pr', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    worktreePath = path.join(dir, 'ship-worktree');
    const start = runCli(['worktree', 'start', '--agent', 'codex-shipper', '--task', 'Ship Smoke', '--path', worktreePath], { cwd: repo });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');

    const binDir = makeFakeGh(dir, { viewState: 'OPEN', viewNumber: 7, mergeAlreadyMerged: true });
    const shipped = runCli(
      ['worktree', 'ship', '--message', 'ship smoke', '--verify', 'git status --short', '--merge'],
      { cwd: worktreePath, env: { PATH: `${binDir}:${process.env.PATH}` } }
    );

    assert.notEqual(shipped.status, 0, 'a no-op merge must never be reported as a successful ship');
    assert.doesNotMatch(shipped.stdout, /done: worktree shipped/);
    assert.match(`${shipped.stdout}${shipped.stderr}`, /already merged/i);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('worktree ship blocks from primary checkout', () => {
  const dir = makeTempDir();
  try {
    const runGit = (args, cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['checkout', '-b', 'codex/primary-ship']);

    const res = runCli(['worktree', 'ship', '--message', 'should block', '--dry-run', '--no-pr'], { cwd: dir });

    assert.equal(res.status, 2);
    assert.match(res.stderr, /blocked: ship from an isolated worktree/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('worktree ship requires a message for dirty isolated checkout', () => {
  const dir = makeTempDir();
  let worktreePath;
  try {
    const remote = path.join(dir, 'remote.git');
    const repo = path.join(dir, 'repo');
    const runGit = (args, cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    runGit(['init', '-q']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
    runGit(['add', '.']);
    runGit(['commit', '-qm', 'init']);
    runGit(['branch', '-M', 'master']);
    runGit(['remote', 'add', 'origin', remote]);
    runGit(['push', '-u', 'origin', 'master']);
    runGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);

    worktreePath = path.join(dir, 'message-worktree');
    assert.equal(runCli([
      'worktree',
      'start',
      '--agent',
      'codex',
      '--task',
      'Message Gate',
      '--path',
      worktreePath,
    ], { cwd: repo }).status, 0);
    fs.appendFileSync(path.join(worktreePath, 'README.md'), 'changed\n');

    const res = runCli(['worktree', 'ship', '--verify', 'git status --short', '--dry-run', '--no-pr'], { cwd: worktreePath });

    assert.equal(res.status, 2);
    assert.match(res.stderr, /--message is required/);
  } finally {
    if (worktreePath) cleanupTempDir(worktreePath);
    cleanupTempDir(dir);
  }
});


test('member create --help prints usage without creating a --help member', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const help = runCli(['member', 'create', '--help'], { cwd: dir });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: atris member create <name>/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', '--help')), false);

    const missingName = runCli(['member', 'create', '--role=Member Trainer'], { cwd: dir });
    assert.notEqual(missingName.status, 0);
    assert.match(missingName.stderr, /Usage: atris member create <name>/);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', '--role=Member Trainer')), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member archive preserves files under _archived', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'old-coach'], { cwd: dir }).status, 0);
    const loopStateDir = path.join(dir, '.atris', 'state', 'member-loops');
    fs.mkdirSync(loopStateDir, { recursive: true });
    fs.writeFileSync(path.join(loopStateDir, 'old-coach.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'old-coach',
      run_id: 'stale-run',
      pid: 999999999,
      started_at: '2026-06-01T00:00:00.000Z',
      heartbeat_at: '2026-06-01T00:00:00.000Z',
      expires_at_ms: Date.now() - 1000,
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(loopStateDir, 'old-coach.stop.json'), JSON.stringify({
      schema: 'atris.member_loop_stop.v1',
      member: 'old-coach',
    }, null, 2), 'utf8');
    const archive = runCli(['member', 'archive', 'old-coach'], { cwd: dir });
    assert.equal(archive.status, 0, archive.stderr || archive.stdout);
    const activePath = path.join(dir, 'atris', 'team', 'old-coach');
    const archiveRoot = path.join(dir, 'atris', 'team', '_archived');
    const archived = fs.readdirSync(archiveRoot).find((name) => name.startsWith('old-coach-'));
    assert.equal(fs.existsSync(activePath), false);
    assert.ok(archived);
    assert.ok(fs.existsSync(path.join(archiveRoot, archived, 'MEMBER.md')));
    const logs = fs.readdirSync(path.join(archiveRoot, archived, 'logs'));
    assert.ok(logs.some((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)));
    assert.equal(fs.existsSync(path.join(loopStateDir, 'old-coach.lock.json')), false);
    assert.equal(fs.existsSync(path.join(loopStateDir, 'old-coach.stop.json')), false);
    const latest = JSON.parse(fs.readFileSync(path.join(loopStateDir, 'old-coach.latest.json'), 'utf8'));
    assert.equal(latest.status, 'archived');
    assert.equal(latest.stale_lease_removed, true);
    assert.equal(latest.previous_lease.run_id, 'stale-run');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member purge archived requires confirmation and age gate', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'stale-coach'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'archive', 'stale-coach'], { cwd: dir }).status, 0);
    const archiveRoot = path.join(dir, 'atris', 'team', '_archived');
    const archived = fs.readdirSync(archiveRoot).find((name) => name.startsWith('stale-coach-'));
    const archivedPath = path.join(archiveRoot, archived);
    const refused = runCli(['member', 'purge-archived', '--days=60'], { cwd: dir });
    assert.notEqual(refused.status, 0);
    assert.ok(fs.existsSync(archivedPath));
    const recent = runCli(['member', 'purge-archived', '--days=60', '--confirm', 'delete archived members'], { cwd: dir });
    assert.equal(recent.status, 0, recent.stderr || recent.stdout);
    assert.ok(fs.existsSync(archivedPath));
    const old = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
    fs.utimesSync(archivedPath, old, old);
    const purged = runCli(['member', 'purge-archived', '--days=60', '--confirm', 'delete archived members'], { cwd: dir });
    assert.equal(purged.status, 0, purged.stderr || purged.stdout);
    assert.equal(fs.existsSync(archivedPath), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal tick review compounds structured goals and logs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'growth'], { cwd: dir }).status, 0);

    const goal = runCli([
      'member', 'goal', 'growth', 'Recover more customer revenue',
      '--why', 'prove member-owned business progress',
      '--acceptance', 'one verified recovery action',
      '--cadence', 'daily',
      '--json',
    ], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    assert.equal(goalPayload.action, 'goal_created');
    assert.equal(goalPayload.goal.title, 'Recover more customer revenue');
    assert.deepEqual(goalPayload.goal.acceptance, ['one verified recovery action']);

    const goalsPath = path.join(dir, 'atris', 'team', 'growth', 'goals.json');
    const goalsMdPath = path.join(dir, 'atris', 'team', 'growth', 'goals.md');
    assert.ok(fs.existsSync(goalsPath));
    assert.ok(fs.existsSync(goalsMdPath));
    assert.match(fs.readFileSync(goalsMdPath, 'utf8'), /Recover more customer revenue/);

    const tick = runCli(['member', 'tick', 'growth', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'tick');
    assert.equal(tickPayload.reused, false);
    assert.equal(tickPayload.experiment.status, 'proposed');
    assert.match(tickPayload.experiment.proof_target, /verified recovery action/);

    const secondTick = runCli(['member', 'tick', 'growth', '--json'], { cwd: dir });
    assert.equal(secondTick.status, 0, secondTick.stderr || secondTick.stdout);
    const secondTickPayload = JSON.parse(secondTick.stdout);
    assert.equal(secondTickPayload.reused, true);
    assert.equal(secondTickPayload.experiment.id, tickPayload.experiment.id);

    const openStatus = runCli(['member', 'status', 'growth', '--json'], { cwd: dir });
    assert.equal(openStatus.status, 0, openStatus.stderr || openStatus.stdout);
    const openStatusPayload = JSON.parse(openStatus.stdout);
    assert.equal(openStatusPayload.state, 'proposed');
    assert.equal(openStatusPayload.current_experiment.id, tickPayload.experiment.id);
    assert.match(openStatusPayload.next_command, /member review growth/);

    const review = runCli([
      'member', 'review', 'growth', tickPayload.experiment.id,
      '--accept',
      '--proof', 'dry run produced a verified recovery action',
      '--value', '5',
      '--lesson', 'small proof targets keep the member honest',
      '--next', 'Prepare the next recovery experiment',
      '--json',
    ], { cwd: dir });
    assert.equal(review.status, 0, review.stderr || review.stdout);
    const reviewPayload = JSON.parse(review.stdout);
    assert.equal(reviewPayload.outcome, 'accepted');
    assert.equal(reviewPayload.value, 5);
    assert.equal(reviewPayload.experiment.proof, 'dry run produced a verified recovery action');
    assert.equal(reviewPayload.experiment.value, 5);
    assert.equal(reviewPayload.next_experiment.status, 'proposed');

    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.schema, 'atris.member_goals.v1');
    assert.equal(state.goals[0].experiments[0].status, 'accepted');
    assert.equal(state.goals[0].experiments[0].value, 5);
    assert.equal(state.goals[0].experiments[1].title, 'Prepare the next recovery experiment');

    const duplicateReview = runCli([
      'member', 'review', 'growth', tickPayload.experiment.id,
      '--accept',
      '--proof', 'second review should not mutate closed experiment',
      '--next', 'Duplicate next experiment',
      '--json',
    ], { cwd: dir });
    assert.notEqual(duplicateReview.status, 0);
    assert.match(duplicateReview.stderr, /already accepted/);

    const blockAccepted = runCli([
      'member', 'block', 'growth', tickPayload.experiment.id,
      '--reason', 'late blocker',
      '--ask', 'Should not apply',
      '--json',
    ], { cwd: dir });
    assert.notEqual(blockAccepted.status, 0);
    assert.match(blockAccepted.stderr, /already accepted/);

    const afterRefused = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(afterRefused.goals[0].experiments.length, 2);
    assert.equal(afterRefused.goals[0].experiments[0].status, 'accepted');
    assert.equal(afterRefused.goals[0].experiments[0].proof, 'dry run produced a verified recovery action');
    assert.equal(afterRefused.goals[0].experiments[1].title, 'Prepare the next recovery experiment');
    const doneStatus = runCli(['member', 'status', 'growth', '--json'], { cwd: dir });
    assert.equal(doneStatus.status, 0, doneStatus.stderr || doneStatus.stdout);
    const doneStatusPayload = JSON.parse(doneStatus.stdout);
    assert.equal(doneStatusPayload.value.average, 5);
    assert.equal(doneStatusPayload.value.accepted, 1);
    const logsDir = path.join(dir, 'atris', 'team', 'growth', 'logs');
    const logText = fs.readdirSync(logsDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => fs.readFileSync(path.join(logsDir, name), 'utf8'))
      .join('\n');
    assert.match(logText, /Member goal created/);
    assert.match(logText, /Member tick proposed experiment/);
    assert.match(logText, /Member experiment accepted/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission creates a bounded goal without a human title', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    const startedMission = runCli([
      'mission', 'start', '--no-verify', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(startedMission.status, 0, startedMission.stderr || startedMission.stdout);
    const mission = JSON.parse(startedMission.stdout).mission;
    const missionTaskAdd = runCli([
      'task', 'add', 'Build the mission-owned task loop',
      '--tag', 'mission',
      '--goal-id', mission.id,
      '--json',
    ], { cwd: dir });
    assert.equal(missionTaskAdd.status, 0, missionTaskAdd.stderr || missionTaskAdd.stdout);
    const missionTask = JSON.parse(missionTaskAdd.stdout).task;
    const missionTaskClaim = runCli(['task', 'claim', missionTask.display_id, '--as', 'mission-lead'], { cwd: dir });
    assert.equal(missionTaskClaim.status, 0, missionTaskClaim.stderr || missionTaskClaim.stdout);

    const goal = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'goal_from_mission_created');
    assert.equal(payload.goal.source, 'mission');
    assert.match(payload.goal.title, /Make Missions change the world/);
    assert.doesNotMatch(payload.goal.title, /Prove one bounded step toward/, 'goal title carries the mission focus without boilerplate');
    assert.match(payload.goal.why, /Make Missions change the world/);
    assert.equal(payload.goal.mission_file, 'atris/team/mission-lead/MISSION.md');
    assert.equal(payload.goal.now_file, 'atris/team/mission-lead/now.md');
    assert.ok(payload.goal.mission_id);
    assert.equal(payload.task.ref, missionTask.display_id);
    assert.equal(payload.native_goal.task.ref, missionTask.display_id);
    assert.match(payload.native_goal.objective, /mission-lead: complete/);
    assert.match(payload.native_goal.objective, /Build the mission-owned task loop/);
    assert.equal(payload.native_goal.slash_goal, payload.native_goal.objective);
    assert.match(payload.native_goal.next_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));
    assert.equal(payload.goal.native_goal.objective, payload.native_goal.objective);
    assert.match(payload.next_command, new RegExp(`atris task current-step --goal-id ${mission.id}`));

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const goalsMdPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.md');
    assert.ok(fs.existsSync(goalsPath));
    assert.ok(fs.existsSync(goalsMdPath));
    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.goals.length, 1);
    assert.equal(state.goals[0].source, 'mission');
    assert.match(fs.readFileSync(goalsMdPath, 'utf8'), /not hand-fed by the human/);

    const tick = runCli(['member', 'tick', 'mission-lead', '--goal', payload.goal.id, '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'tick');
    assert.equal(tickPayload.goal_id, payload.goal.id);
    assert.equal(tickPayload.experiment.status, 'proposed');
    assert.match(tickPayload.experiment.proof_target, /MISSION\.md/);
    assert.match(tickPayload.experiment.next_step, /MISSION\.md/);

    const reused = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(reused.status, 0, reused.stderr || reused.stdout);
    const reusedPayload = JSON.parse(reused.stdout);
    assert.equal(reusedPayload.action, 'goal_from_mission_reused');
    assert.equal(reusedPayload.goal.id, payload.goal.id);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission does not append a duplicate history entry on every reuse tick', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['mission', 'start', '--no-verify', 'Make Missions change the world', '--owner', 'mission-lead', '--json'], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const historyLen = () => JSON.parse(fs.readFileSync(goalsPath, 'utf8')).goals[0].history.length;
    const afterCreate = historyLen();

    // The cadence loop reuses the same goal every tick. Before the fix each tick appended an identical
    // no-op `goal_from_mission_reused` entry, growing goals.json without bound (2,200+ entries live).
    for (let i = 0; i < 30; i += 1) {
      assert.equal(runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir }).status, 0);
    }
    const afterReuse = historyLen();
    assert.ok(afterReuse <= afterCreate + 1, `reuse ticks must not append duplicate history (was ${afterCreate}, now ${afterReuse} after 30 identical reuses)`);
    assert.ok(afterReuse <= 50, `history must stay capped, got ${afterReuse}`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission stops when active mission is blocked', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const nowPath = path.join(dir, 'atris', 'team', 'mission-lead', 'now.md');
    const nowText = fs.readFileSync(nowPath, 'utf8');
    fs.writeFileSync(nowPath, nowText.replace(/^- status: .+$/m, '- status: blocked').replace(/^- next: .+$/m, '- next: fix verifier failure or revise mission'), 'utf8');

    const blocked = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.action, 'needs_user');
    assert.equal(payload.needs_user, true);
    assert.match(payload.ask, /blocked/i);
    assert.match(payload.ask, /fix verifier failure or revise mission/i);

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    if (fs.existsSync(goalsPath)) {
      const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
      assert.equal(state.goals.length, 0);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission stops when active mission is complete and --force cannot bypass', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const nowPath = path.join(dir, 'atris', 'team', 'mission-lead', 'now.md');
    const nowText = fs.readFileSync(nowPath, 'utf8');
    fs.writeFileSync(nowPath, nowText.replace(/^- status: .+$/m, '- status: complete'), 'utf8');

    for (const extra of [[], ['--force']]) {
      const res = runCli(['member', 'goal-from-mission', 'mission-lead', ...extra, '--json'], { cwd: dir });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.action, 'needs_user');
      assert.equal(payload.needs_user, true);
      assert.match(payload.ask, /complete/i);
      assert.deepEqual(payload.stale_goals, []);
    }

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    if (fs.existsSync(goalsPath)) {
      const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
      assert.equal(state.goals.length, 0);
    }
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission names stale goals when the mission turns stopped', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions change the world with self-generated goals',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdGoal = JSON.parse(created.stdout).goal;
    assert.equal(createdGoal.status, 'active');
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const before = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    const unlinked = { ...createdGoal, id: 'unlinked-goal', title: 'Unlinked work' };
    delete unlinked.mission_id;
    before.goals.push(
      { ...createdGoal, id: 'living-goal', title: 'Living mission work', mission_id: 'living-mission' },
      unlinked,
    );
    fs.writeFileSync(goalsPath, JSON.stringify(before, null, 2), 'utf8');

    const nowPath = path.join(dir, 'atris', 'team', 'mission-lead', 'now.md');
    const nowText = fs.readFileSync(nowPath, 'utf8');
    fs.writeFileSync(nowPath, nowText.replace(/^- status: .+$/m, '- status: stopped'), 'utf8');

    const res = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.action, 'needs_user');
    assert.equal(payload.needs_user, true);
    assert.match(payload.ask, /stopped/i);
    assert.match(payload.ask, new RegExp(createdGoal.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 40)));
    assert.equal(payload.stale_goals.length, 1);
    assert.equal(payload.stale_goals[0].id, createdGoal.id);
    assert.doesNotMatch(payload.ask, /Living mission work|Unlinked work/);

    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.deepEqual(state, before, 'guard must preserve goals and only identify the finished mission’s own goal');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission preserves completed same-day proof history', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions preserve completed proof history"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions preserve completed proof history',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdPayload = JSON.parse(created.stdout);
    const completedId = createdPayload.goal.id;
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    state.goals[0].status = 'completed';
    state.goals[0].completed_at = '2026-06-04T00:00:00.000Z';
    state.goals[0].completed_reason = 'accepted_experiment_proof';
    state.goals[0].experiments = [
      {
        id: 'exp-proof',
        title: 'Accepted proof',
        status: 'accepted',
        proof: 'receipt-backed proof',
        reviewed_at: '2026-06-04T00:00:00.000Z',
        value: 4,
      },
    ];
    fs.writeFileSync(goalsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const next = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(next.status, 0, next.stderr || next.stdout);
    const nextPayload = JSON.parse(next.stdout);
    const nextState = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    const completed = nextState.goals.find((goal) => goal.id === completedId);
    assert.equal(nextPayload.action, 'goal_from_mission_created');
    assert.notEqual(nextPayload.goal.id, completedId);
    assert.match(nextPayload.goal.id, new RegExp(`^${completedId}-2$`));
    assert.equal(nextState.goals[0].id, nextPayload.goal.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.experiments[0].id, 'exp-proof');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-mission promotes the mission goal before older active goals', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions change the world with self-generated goals"'], { cwd: dir }).status, 0);
    const scoreGoal = runCli(['member', 'goal', 'mission-lead', 'Older score-derived goal', '--json'], { cwd: dir });
    assert.equal(scoreGoal.status, 0, scoreGoal.stderr || scoreGoal.stdout);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions choose the next bounded goal',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const created = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdPayload = JSON.parse(created.stdout);
    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    let state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.goals[0].id, createdPayload.goal.id);

    state.goals.reverse();
    fs.writeFileSync(goalsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const reused = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(reused.status, 0, reused.stderr || reused.stdout);
    const reusedPayload = JSON.parse(reused.stdout);
    state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(reusedPayload.action, 'goal_from_mission_reused');
    assert.equal(state.goals[0].id, createdPayload.goal.id);
    assert.equal(state.goals[1].title, 'Older score-derived goal');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member goal-from-score creates the active self-improvement goal from Team score evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions turn proof into self-generated goals"'], { cwd: dir }).status, 0);
    const oldGoal = runCli(['member', 'goal', 'mission-lead', 'Old broad mission goal', '--json'], { cwd: dir });
    assert.equal(oldGoal.status, 0, oldGoal.stderr || oldGoal.stdout);
    const oldGoalPayload = JSON.parse(oldGoal.stdout);
    const oldTick = runCli(['member', 'tick', 'mission-lead', '--goal', oldGoalPayload.goal.id, '--json'], { cwd: dir });
    assert.equal(oldTick.status, 0, oldTick.stderr || oldTick.stdout);
    const oldExperimentId = JSON.parse(oldTick.stdout).experiment.id;
    const scorePath = path.join(dir, 'team-score.json');
    fs.writeFileSync(scorePath, JSON.stringify({
      score: {
        overall: 74,
        formula: 'Team Overall = Task Output + Knowledge Health + Member Performance',
        nextMove: 'Raise Member Performance: Train the weakest member attribute with one verified loop.',
        weakest: {
          id: 'member_performance',
          label: 'Member Performance',
          score: 60,
          recommendation: 'Train the weakest member attribute with one verified loop.',
          evidence: '14 scored members / proof avg 51 / loop avg 63',
        },
      },
      taskLedger: {
        latestReward: {
          ref: 'OBL-157',
          title: 'Show latest reward receipt in Team score CLI',
          reward: 5,
          proof: 'latestReward present in JSON and text output',
        },
      },
      learningPacket: {
        targetMember: {
          slug: 'brainstormer',
          label: 'brainstormer',
          overall: 60,
          next: 'Upgrade proof: finish one run with receipt, test, review, or artifact evidence.',
          weakestAttribute: {
            id: 'proof',
            label: 'Proof quality',
            score: 48,
            line: 'Proof status: no task proof yet.',
          },
        },
        drill: 'Run one bounded loop for brainstormer: Upgrade proof: finish one run with receipt, test, review, or artifact evidence. Weakest attribute: Proof quality 48.',
        verifier: 'npm run test:team-overall && node scripts/team-overall-score.mjs --json',
      },
    }, null, 2), 'utf8');

    const goal = runCli(['member', 'goal-from-score', 'mission-lead', '--score-json', scorePath, '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const payload = JSON.parse(goal.stdout);
    assert.equal(payload.action, 'goal_from_score_created');
    assert.equal(payload.goal.source, 'team_score');
    assert.match(payload.goal.title, /Raise Member Performance/);
    assert.equal(payload.goal.team_score.weakest.label, 'Member Performance');
    assert.equal(payload.goal.team_score.latest_reward.ref, 'OBL-157');
    assert.equal(payload.goal.team_score.target_member.slug, 'brainstormer');
    assert.match(payload.goal.team_score.drill, /brainstormer/);
    assert.match(payload.goal.acceptance[0], /score-selected next move/);
    assert.match(payload.goal.acceptance[2], /Target member: brainstormer/);
    assert.equal(payload.superseded_experiments.length, 1);
    assert.equal(payload.superseded_experiments[0].experiment_id, oldExperimentId);
    assert.match(payload.next_command, /atris member tick mission-lead --goal/);

    const goalsPath = path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json');
    const state = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(state.goals[0].id, payload.goal.id);
    assert.equal(state.goals[0].source, 'team_score');
    assert.equal(state.goals[1].title, 'Old broad mission goal');
    assert.equal(state.goals[1].experiments[0].status, 'superseded');

    const tick = runCli(['member', 'tick', 'mission-lead', '--goal', payload.goal.id, '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.goal_id, payload.goal.id);
    assert.match(tickPayload.experiment.title, /brainstormer drill/);
    assert.match(tickPayload.experiment.proof_target, /Concrete drill: Run one bounded loop for brainstormer/);
    assert.match(tickPayload.experiment.next_step, /Proof quality 48/);
    assert.equal(tickPayload.experiment.target_member.slug, 'brainstormer');
    assert.match(tickPayload.experiment.verifier, /test:team-overall/);

    const reused = runCli(['member', 'goal-from-score', 'mission-lead', '--score-json', scorePath, '--json'], { cwd: dir });
    assert.equal(reused.status, 0, reused.stderr || reused.stdout);
    const reusedPayload = JSON.parse(reused.stdout);
    assert.equal(reusedPayload.action, 'goal_from_score_reused');
    assert.equal(reusedPayload.goal.id, payload.goal.id);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake returns one finite decision and refuses to pile onto open work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions wake up safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions wake up safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);
    const goal = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);
    const dryRun = runCli(['member', 'wake', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryRunPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryRunPayload.action, 'wake');
    assert.equal(dryRunPayload.mode, 'dry_run');
    assert.equal(dryRunPayload.decision, 'tick');
    assert.equal(dryRunPayload.executed, false);
    assert.match(dryRunPayload.next_command, new RegExp(`member tick mission-lead --goal ${goalPayload.goal.id}`));
    assert.equal(dryRunPayload.now_file.path, 'atris/team/mission-lead/now.md');
    assert.match(dryRunPayload.now_file.excerpt, /Make Missions wake up safely/);
    assert.deepEqual(dryRunPayload.goals, [{
      id: goalPayload.goal.id,
      title: goalPayload.goal.title,
      status: goalPayload.goal.status,
    }]);
    assert.ok(fs.existsSync(dryRunPayload.receipt_path));
    const dryReceipt = JSON.parse(fs.readFileSync(dryRunPayload.receipt_path, 'utf8'));
    assert.equal(dryReceipt.schema, 'atris.member_wake.v1');
    assert.equal(dryReceipt.decision, 'tick');
    assert.deepEqual(dryReceipt.now_file, dryRunPayload.now_file);
    assert.deepEqual(dryReceipt.goals, dryRunPayload.goals);

    const refused = runCli(['member', 'wake', 'mission-lead', '--execute', '--json'], { cwd: dir });
    assert.equal(refused.status, 0, refused.stderr || refused.stdout);
    const refusedPayload = JSON.parse(refused.stdout);
    assert.equal(refusedPayload.decision, 'stop');
    assert.equal(refusedPayload.reason, 'execute_requires_confirm_autonomy_policy');
    let state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 0);

    const executed = runCli(['member', 'wake', 'mission-lead', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const executedPayload = JSON.parse(executed.stdout);
    assert.equal(executedPayload.executed, true);
    assert.equal(executedPayload.decision, 'wait');
    assert.equal(executedPayload.reason, 'tick_executed_experiment_proposed');
    assert.equal(executedPayload.current_experiment.status, 'proposed');
    assert.ok(fs.existsSync(executedPayload.receipt_path));

    // The open proposal is an unreviewable fallback (no verifier), so wake no
    // longer parks the member on a gate nobody can clear: it offers the next
    // bounded tick instead. The stale fallback is superseded only when the
    // next executed tick proposes its replacement; a dry wake mutates nothing.
    const wait = runCli(['member', 'wake', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(wait.status, 0, wait.stderr || wait.stdout);
    const waitPayload = JSON.parse(wait.stdout);
    assert.equal(waitPayload.decision, 'tick');
    assert.equal(waitPayload.reason, 'safe_next_bounded_step');
    assert.equal(waitPayload.current_experiment, null);
    assert.match(waitPayload.next_command, new RegExp(`member tick mission-lead --goal ${goalPayload.goal.id}`));
    state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
    assert.equal(state.goals[0].experiments[0].status, 'proposed');
    const logText = fs.readdirSync(path.join(dir, 'atris', 'team', 'mission-lead', 'logs'))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'logs', name), 'utf8'))
      .join('\n');
    assert.match(logText, /Member wake decision/);
    assert.match(logText, /Member wake executed tick/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake asks instead of ticking a goal pinned to a terminal mission', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions wake up safely"'], { cwd: dir }).status, 0);
    const startedMission = runCli([
      'mission', 'start', '--no-verify', 'Make Missions wake up safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir });
    assert.equal(startedMission.status, 0, startedMission.stderr || startedMission.stdout);
    const mission = JSON.parse(startedMission.stdout).mission;

    const goal = runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalId = JSON.parse(goal.stdout).goal.id;

    const stopped = runCli(['mission', 'stop', mission.id, '--json'], { cwd: dir });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);

    const wake = runCli(['member', 'wake', 'mission-lead', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'ask');
    assert.equal(payload.reason, 'goal_mission_terminal:stopped');
    assert.equal(payload.needs_user, true);
    assert.match(payload.ask, new RegExp(mission.id));
    assert.doesNotMatch(String(payload.next_command || ''), /member tick/);
    assert.equal(payload.goals?.[0]?.id, goalId);

    // A dry wake mutates nothing: the goal stays active, no experiment is proposed.
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].status, 'active');
    assert.equal(state.goals[0].experiments.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake treats member-generated goals and logs as non-blocking bookkeeping', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'aeo', '--description="Own AEO proof loops"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Keep AEO moving',
      '--owner', 'aeo',
      '--json',
    ], { cwd: dir }).status, 0);
    const goal = runCli(['member', 'goal-from-mission', 'aeo', '--json'], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);

    const logsDir = path.join(dir, 'atris', 'team', 'aeo', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, '2026-07-05.md');
    fs.writeFileSync(logPath, '# generated baseline\n', 'utf8');

    const runGitOk = (args) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    runGitOk(['init', '-q']);
    runGitOk(['config', 'user.email', 'test@example.com']);
    runGitOk(['config', 'user.name', 'Test User']);
    runGitOk(['add', '.']);
    runGitOk(['commit', '-qm', 'baseline']);

    const goalsPath = path.join(dir, 'atris', 'team', 'aeo', 'goals.json');
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    goals.generated_bookkeeping = { touched_at: '2026-07-05T00:00:00.000Z' };
    fs.writeFileSync(goalsPath, `${JSON.stringify(goals, null, 2)}\n`, 'utf8');
    fs.appendFileSync(logPath, '\n## generated wake bookkeeping\n', 'utf8');

    const wake = runCli(['member', 'wake', 'aeo', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.workspace.clean_for_member, true);
    assert.equal(payload.workspace.dirty_count_in_scope, 0);
    assert.deepEqual(payload.workspace.dirty_in_scope_sample, []);

    fs.writeFileSync(path.join(dir, 'atris', 'team', 'aeo', 'operator-note.md'), 'real unlanded member work\n', 'utf8');
    const blocked = runCli(['member', 'wake', 'aeo', '--json'], { cwd: dir });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.decision, 'wait');
    assert.equal(blockedPayload.reason, 'workspace_dirty_in_member_scope');
    assert.equal(blockedPayload.workspace.clean_for_member, false);
    assert.match(blockedPayload.workspace.dirty_in_scope_sample.join('\n'), /operator-note\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake can change direction from scoped steering memory', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    const baseline = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    const baselinePayload = JSON.parse(baseline.stdout);
    assert.equal(baselinePayload.decision, 'tick');
    assert.equal(baselinePayload.checks.has_steering_directive, false);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'steering.jsonl'), `${JSON.stringify({
      schema: 'atris.steering.v1',
      id: 'steer_test_report_proof',
      created_at: '2026-05-06T00:00:00.000Z',
      scope: { project: 'obelisk', member: 'command-leader' },
      kind: 'operating_rule',
      memory: ['Wake directive: report_proof - OBL-150 "Report the latest loop proof before creating new work."'],
      status: 'active',
    })}\n`, 'utf8');

    const steered = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(steered.status, 0, steered.stderr || steered.stdout);
    const steeredPayload = JSON.parse(steered.stdout);
    assert.equal(steeredPayload.decision, 'report_proof');
    assert.equal(steeredPayload.reason, 'steering_directive:steer_test_report_proof');
    assert.equal(steeredPayload.checks.has_steering, true);
    assert.equal(steeredPayload.checks.has_steering_directive, true);
    assert.match(steeredPayload.next_command, /atris task note OBL-150/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake ignores steering directives whose task refs are all closed', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'closed-failed',
          display_id: 'OBL-146',
          title: 'Failed source room proof',
          status: 'failed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { reward: 0, proof: 'reviewed failure' },
        },
        {
          id: 'closed-done',
          display_id: 'OBL-147',
          title: 'Done source room proof',
          status: 'done',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { reward: 1, proof: 'accepted proof' },
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'steering.jsonl'), `${JSON.stringify({
      schema: 'atris.steering.v1',
      id: 'steer_closed_refs',
      created_at: '2026-05-06T00:00:00.000Z',
      scope: { project: 'obelisk', member: 'command-leader' },
      kind: 'operating_rule',
      memory: ['Wake directive: close_loop - OBL-146 and OBL-147 were the referenced loops.'],
      status: 'active',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'safe_next_bounded_step');
    assert.equal(payload.checks.has_steering, true);
    assert.equal(payload.checks.has_steering_directive, false);
    assert.equal(payload.checks.has_satisfied_steering_directive, true);
    assert.equal(payload.evidence.task_projection.candidate_count, 0);
    assert.equal(payload.evidence.nearest_open_loop, null);
    assert.equal(payload.evidence.steering_directive_closure.all_closed, true);
    assert.deepEqual(payload.evidence.steering_directive_closure.closed_refs, ['OBL-146', 'OBL-147']);
    assert.match(payload.next_command, /atris member tick command-leader --goal/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake closes the nearest open task from task projection evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'task-one',
          display_id: 'OBL-200',
          title: 'Close the live command loop',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          current_version: 2,
          messages: [],
          events: [],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-200');
    assert.equal(payload.checks.has_open_loop_evidence, true);
    assert.equal(payload.checks.open_loop_source, 'task_projection');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-200');
    assert.match(payload.next_command, /atris task note OBL-200/);
    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.evidence.nearest_open_loop.task_ref, 'OBL-200');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake reports proof for completed task evidence missing proof', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'task-two',
          display_id: 'OBL-201',
          title: 'Report the loop closure proof',
          status: 'done',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { reward: null, proof: null },
          current_version: 3,
          messages: [],
          events: [],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'report_proof');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-201');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-201');
    assert.match(payload.next_command, /atris task note OBL-201/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake skips proof-ready review task evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'review-ready',
          display_id: 'OBL-202',
          title: 'Proof-ready card should wait for review',
          status: 'review',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          review: { proof: 'Already has proof.' },
          latest_event_type: 'proof_ready',
          updated_at: 1778058000000,
        },
        {
          id: 'real-work',
          display_id: 'OBL-203',
          title: 'Do the next real business task',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778057000000,
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-203');
    assert.equal(payload.evidence.task_projection.candidate_count, 1);
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-203');
    assert.match(payload.next_command, /atris task note OBL-203/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake creates a missing task from member-room evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);

    const threadDir = path.join(dir, '.obelisk', 'threads', 'project-one');
    fs.mkdirSync(threadDir, { recursive: true });
    fs.writeFileSync(path.join(threadDir, 'room.json'), JSON.stringify({
      id: 'room-one',
      updatedAt: Date.now(),
      atrisContext: {
        teamMember: 'command-leader',
        linkedTasks: [],
      },
      messages: [
        { role: 'user', text: 'build a proof card for the newest command loop' },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'create_missing_task');
    assert.equal(payload.reason, 'nearest_open_loop:member_room_unlinked_request:missing_task');
    assert.equal(payload.checks.has_member_room_evidence, true);
    assert.match(payload.next_command, /atris task delegate "build a proof card/);
    assert.equal(payload.evidence.nearest_open_loop.source, 'member_room_unlinked_request');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake discovers autonomous objective from scorecard signal with no active goal', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'scorecards.jsonl'), `${JSON.stringify({
      schema: 'atris.brain.scorecard.v1',
      type: 'scorecard',
      reward: 0.4,
      next_task_suggestion: 'Build autonomous problem scanner from telemetry receipts',
      lesson: 'The loop had no member goal even though telemetry exposed a high-value AGI gap.',
      created_at: `${recentLogDate()}T10:00:00.000Z`,
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'set_objective');
    assert.equal(payload.reason, 'autonomous_problem_discovery:scorecards');
    assert.equal(payload.checks.has_goal, false);
    assert.equal(payload.checks.has_autonomous_problem_candidate, true);
    assert.equal(payload.checks.autonomous_problem_source, 'scorecards');
    assert.match(payload.autonomous_problem.objective_title, /autonomous problem scanner/i);
    assert.match(payload.next_command, /member wake command-leader --execute --confirm-autonomy-policy/);
    // Member create now pre-scaffolds an empty goals file; absence of a goal
    // means an empty goals array, not a missing file.
    const preGoals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'command-leader', 'goals.json'), 'utf8'));
    assert.equal((preGoals.goals || []).length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake execute seeds autonomous objective from Pulse AGI receipt', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'pulse_agi_loop_receipts.jsonl'), `${JSON.stringify({
      schema: 'atris.pulse_agi_loop_receipt.v1',
      phase: 'DECIDE',
      task: 'verify Pulse AGI-loop runtime work',
      why: 'Pulse discovered autonomous coordination lacks a durable objective seed.',
      recommended_next_action: 'Seed an autonomous objective from Pulse AGI receipts and prove the next bounded member tick',
      created_at: `${recentLogDate()}T11:00:00.000Z`,
    })}\n`, 'utf8');

    const refused = runCli(['member', 'wake', 'command-leader', '--execute', '--json'], { cwd: dir });
    assert.equal(refused.status, 0, refused.stderr || refused.stdout);
    const refusedPayload = JSON.parse(refused.stdout);
    assert.equal(refusedPayload.decision, 'stop');
    assert.equal(refusedPayload.reason, 'execute_requires_confirm_autonomy_policy');
    // Pre-scaffolded goals file exists but must still hold zero goals.
    const refusedGoals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'command-leader', 'goals.json'), 'utf8'));
    assert.equal((refusedGoals.goals || []).length, 0);

    const executed = runCli(['member', 'wake', 'command-leader', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const payload = JSON.parse(executed.stdout);
    assert.equal(payload.executed, true);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'autonomous_objective_seeded');
    assert.equal(payload.active_goal.source, 'autonomous_problem_discovery');
    assert.match(payload.active_goal.title, /Pulse AGI receipts/i);
    assert.match(payload.next_command, /member tick command-leader --goal/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'command-leader', 'goals.json'), 'utf8'));
    assert.equal(state.goals.length, 1);
    assert.equal(state.goals[0].source, 'autonomous_problem_discovery');
    assert.equal(state.goals[0].source_signal.source, 'pulse_agi_loop_receipts');
    assert.match(state.goals[0].acceptance.join('\n'), /do not claim the full AGI bar is complete/i);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake discovers autonomous objective from env-declared external signal root', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    const externalRoot = path.join(dir, 'external-signals');
    fs.mkdirSync(path.join(externalRoot, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(externalRoot, '.atris', 'state', 'scorecards.jsonl'), `${JSON.stringify({
      schema: 'atris.external.scorecard.v1',
      type: 'scorecard',
      reward: 0.2,
      next_task_suggestion: 'Scan customer behavior metrics for autonomous objective gaps',
      lesson: 'External metrics show repeated user dropoff before member objective creation.',
      created_at: '2026-06-03T09:00:00.000Z',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], {
      cwd: dir,
      env: { ATRIS_MEMBER_SIGNAL_ROOTS: externalRoot },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'set_objective');
    assert.equal(payload.reason, 'autonomous_problem_discovery:external_signals_scorecards');
    assert.equal(payload.checks.autonomous_problem_source, 'external_signals_scorecards');
    assert.match(payload.autonomous_problem.objective_title, /customer behavior metrics/i);
    assert.ok(payload.evidence.problem_discovery.sources_with_rows.find((source) => source.source === 'external_signals_scorecards'));
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake discovers autonomous objective from configured metrics signal file', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'signals'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'member-signal-sources.json'), JSON.stringify({
      sources: [
        { source: 'api_metrics', path: 'signals/api-metrics.jsonl', kind: 'jsonl' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'signals', 'api-metrics.jsonl'), `${JSON.stringify({
      schema: 'atris.metrics.problem_signal.v1',
      current_blocker: 'API metrics show onboarding users stall before any member objective exists.',
      recommended_next_action: 'Patch onboarding API conversion drop from user behavior metrics',
      created_at: '2026-06-03T09:15:00.000Z',
    })}\n`, 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'set_objective');
    assert.equal(payload.reason, 'autonomous_problem_discovery:api_metrics');
    assert.equal(payload.checks.autonomous_problem_source, 'api_metrics');
    assert.match(payload.autonomous_problem.problem, /API metrics/);
    assert.match(payload.autonomous_problem.suggested_action, /conversion drop/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('signal-scout wake creates auto-discovery task from recurring log errors', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'signal-scout', '--description="Turn repeated errors into bounded tasks"'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'signal-scout', '--json'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR renderer crashed while opening Team Hub queue';
    fs.writeFileSync(path.join(logsDir, '2026-06-04.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '- unrelated warning',
      '',
    ].join('\n'), 'utf8');

    const scriptPath = path.join(dir, 'scripts', 'scan-errors.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, `
import { readFileSync } from 'node:fs';
import path from 'node:path';
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
const filePath = path.join(root, 'atris', 'logs', '2026', '2026-06-04.md');
const lines = readFileSync(filePath, 'utf8').split(/\\r?\\n/);
const matches = lines.map((line, index) => ({ line, index })).filter((row) => /error|failed|crashed/i.test(row.line));
const counts = new Map();
for (const row of matches) {
  const pattern = row.line.replace(/^\\s*[-*]\\s+/, '').trim();
  const existing = counts.get(pattern) || { pattern, count: 0, evidence: [] };
  existing.count += 1;
  existing.evidence.push({ path: 'atris/logs/2026/2026-06-04.md', line: row.index + 1, text: row.line });
  counts.set(pattern, existing);
}
const selected = [...counts.values()].sort((a, b) => b.count - a.count)[0] || null;
console.log(JSON.stringify({ ok: true, schema: 'atris.error_scan.v1', threshold: 3, since_hours: 24, pattern: selected?.pattern || null, count: selected?.count || 0, selected, scanned: { files: 1, lines: lines.length, matching_lines: matches.length }, matches: [...counts.values()] }));
`, 'utf8');

    const dryRun = runCli(['member', 'wake', 'signal-scout', '--execute', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryPayload.mode, 'dry_run');
    assert.equal(dryPayload.executed, false);
    assert.equal(dryPayload.decision, 'create_task');
    assert.equal(dryPayload.reason, 'autonomous_error_discovery:log_error_scan');
    assert.match(dryPayload.next_command, /atris task new 'Fix recurring error:/);
    assert.equal(fs.existsSync(path.join(dir, '.atris', 'state', 'tasks.projection.json')), false);

    const executed = runCli(['member', 'wake', 'signal-scout', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    const payload = JSON.parse(executed.stdout);
    assert.equal(payload.executed, true);
    assert.equal(payload.decision, 'create_task');
    assert.equal(payload.reason, 'autonomous_error_task_created');
    assert.equal(payload.created_task.tag, 'auto-discovery');
    assert.match(payload.created_task.title, /Fix recurring error: ERROR renderer crashed/);
    assert.equal(payload.autonomous_discovery_receipt.error_count, 3);
    assert.ok(fs.existsSync(payload.receipt_path));

    const projection = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), 'utf8'));
    assert.ok(projection.tasks.some((task) => task.tag === 'auto-discovery' && /Fix recurring error: ERROR renderer crashed/.test(task.title)));
    const projectLog = fs.readFileSync(payload.autonomous_discovery_project_log_path, 'utf8');
    assert.match(projectLog, /Signal Scout autonomous problem discovery/);
    assert.match(projectLog, /ERROR renderer crashed while opening Team Hub queue/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member tick reads goal file evidence and consumes LLM proposal output', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'context', 'agi.md'),
      [
        '# AGI bar',
        'Build a causal model from action to outcome before setting the next objective.',
      ].join('\n'),
      'utf8',
    );
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    const goal = runCli([
      'member', 'goal', 'command-leader',
      'Build AGI objective setting from atris/context/agi.md',
      '--acceptance', 'Use atris/context/agi.md and return one receipt-backed causal proof step.',
      '--json',
    ], { cwd: dir });
    assert.equal(goal.status, 0, goal.stderr || goal.stdout);
    const goalPayload = JSON.parse(goal.stdout);

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const wakePayload = JSON.parse(wake.stdout);
    assert.equal(wakePayload.evidence.goal_files.files_read, 1);
    assert.equal(wakePayload.evidence.goal_files.files[0].path, 'atris/context/agi.md');
    assert.match(wakePayload.evidence.goal_files.files[0].excerpt, /causal model/);

    const tick = runCli(['member', 'tick', 'command-leader', '--goal', goalPayload.goal.id, '--json'], {
      cwd: dir,
      env: {
        ATRIS_MEMBER_PROPOSAL_LLM_JSON: JSON.stringify({
          title: 'Model causal loop from AGI context',
          proof_target: 'Causal action-to-outcome proof from atris/context/agi.md',
          next_step: 'Read atris/context/agi.md, write one action-to-outcome causal claim, and attach the verifier command as proof.',
          verifier: 'node --check commands/member.js',
          stop_rule: 'Stop before architecture mutation or external side effects.',
        }),
      },
    });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.experiment.generation.mode, 'llm');
    assert.equal(tickPayload.experiment.generation.source, 'env_json');
    assert.equal(tickPayload.experiment.title, 'Model causal loop from AGI context');
    assert.match(tickPayload.experiment.next_step, /action-to-outcome causal claim/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake writes dogfood receipt and bounded task', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    const logDate = recentLogDate();
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, `${logDate}.md`), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'task_created');
    assert.equal(payload.auto_improver.schema, 'atris.auto_improver_dogfood.v1');
    assert.equal(payload.auto_improver.proof.prevented_suffering, 1);
    assert.equal(payload.auto_improver.proof.found_problems > 0, true);
    assert.equal(payload.auto_improver.pain.after < payload.auto_improver.pain.before, true);
    assert.equal(payload.created_task.ok, true);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'auto-improver-dogfood-latest.json')));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.match(receipt.scan.prevented_fire_candidate.title, /Recurring log pattern/);
    assert.equal(receipt.created_task.task_ref, payload.created_task.task_ref);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake ignores self-generated recurring-pattern log noise', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    const nestedNoise = '- candidate: Recurring log pattern: candidate: Recurring log pattern: "mission_status": "blocked"';
    const strippedNoise = '- candidate: Next tick will stop until a human looks at the error.';
    const rawLoopNoise = 'Next tick will stop until a human looks at the error.';
    const genericFailureRows = [
      '## 12:37 · Task failed',
      '- status: failed',
      '- action: failed',
      '- state: blocked',
      '- verifier: failed',
      '- title: Auto-improver: Next tick will stop until a human looks at the error.',
      '- title: Make runner error wording config-neutral',
      '- proof: third-actor rerun 2026-06-16: node --test test/task-day-stale-failed.test.js passed 17/17.',
      'Next tick will verify failed, halting.',
    ];
    const resolvedByLesson = 'I hit an error while running "Re-read sources and update atris/features/team-member-standard/validate.md": spawnSync /bin/sh ETIMEDOUT';
    const realPattern = 'ERROR team hub mission_status blocked waiting for owner';
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), [
      '# lessons',
      '',
      '- **[2026-06-18] reconcile-already-shipped-check-git-first** — pass — team-member-standard/validate.md already landed; 2x spawnSync /bin/sh ETIMEDOUT was closeout noise.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      `- ${nestedNoise}`,
      `- ${nestedNoise}`,
      strippedNoise,
      strippedNoise,
      rawLoopNoise,
      rawLoopNoise,
      rawLoopNoise,
      ...genericFailureRows,
      ...genericFailureRows,
      ...genericFailureRows,
      resolvedByLesson,
      resolvedByLesson,
      resolvedByLesson,
      `- ${realPattern}`,
      `- ${realPattern}`,
      `- ${realPattern}`,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'task_created');
    assert.match(payload.created_task.title || payload.created_task.task?.title || '', /^Auto-improver: /);
    assert.doesNotMatch(payload.created_task.title || payload.created_task.task?.title || '', /candidate: Recurring log pattern: candidate:/);

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.doesNotMatch(receipt.scan.prevented_fire_candidate.title, /candidate: Recurring log pattern: candidate:/);
    const repeated = receipt.scan.log_signals.repeated_failures || [];
    assert.deepEqual(
      repeated.filter((failure) => /Next tick will stop until a human looks at the error/.test(failure.pattern)),
      [],
      'generated candidate fields must not feed the recurring-failure scanner',
    );
    assert.deepEqual(
      repeated.filter((failure) => /Next tick will stop until a human looks at the error/.test(failure.pattern)),
      [],
      'generic loop stop lines must not feed the recurring-failure scanner',
    );
    assert.deepEqual(
      repeated.filter((failure) => /Task failed|status: failed|action: failed|state: blocked|verifier: failed|title:|proof:|Next tick will verify failed/i.test(failure.pattern)),
      [],
      'generic structured failure, proof, and title rows must not feed the recurring-failure scanner',
    );
    assert.deepEqual(
      repeated.filter((failure) => /spawnSync \/bin\/sh ETIMEDOUT/.test(failure.pattern)),
      [],
      'failures covered by a pass lesson must not feed the recurring-failure scanner',
    );
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake ignores archived log failures', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const archiveDir = path.join(dir, 'atris', 'logs', 'archive', '2026');
    fs.mkdirSync(archiveDir, { recursive: true });
    const oldPattern = 'ERROR old April loop stopped until a human looked at the error';
    fs.writeFileSync(path.join(archiveDir, '2026-04-09.md'), [
      '# old archived log',
      oldPattern,
      oldPattern,
      oldPattern,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'scan_clean');
    assert.deepEqual(payload.auto_improver.scan.log_signals.repeated_failures, []);
    assert.equal(payload.auto_improver.scan.prevented_fire_candidate, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake selector skips done/accepted tasks (OBL-1469)', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const first = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.decision, 'task_created');
    const firstRef = firstPayload.created_task.task_ref;
    assert.ok(firstRef);

    // Cross the lifecycle boundary as the human: the wake target is now done. Pre-fix the
    // next wake re-selected it forever (the OBL-1433 no-op spiral). Human done
    // still requires meaningful proof (the agent-env scrub made that visible).
    const done = runCli(['task', 'done', firstRef, '--as', 'keshavrao', '--proof', 'verified: rsi route mismatch fixed, curl /api/rsi/improve returns 200', '--json'], { cwd: dir, env: { ...env, ATRIS_AGENT_PROOF_ONLY: '0' } });
    assert.equal(done.status, 0, done.stderr || done.stdout);

    const second = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.notEqual(secondPayload.created_task?.task_ref, firstRef, 'wake must not re-select a done task');
    assert.equal(secondPayload.decision, 'task_created');
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver dry-run surfaces existing actionable task', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const first = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.decision, 'task_created');
    const firstRef = firstPayload.created_task.task_ref;
    assert.ok(firstRef);

    const dryRun = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryRunPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryRunPayload.mode, 'dry_run');
    assert.equal(dryRunPayload.decision, 'existing_task_found');
    assert.equal(dryRunPayload.created_task.existing, true);
    assert.equal(dryRunPayload.created_task.task_ref, firstRef);
    assert.equal(dryRunPayload.next_command, `atris task show ${firstRef} --json`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver dry-run matches legacy recurring-pattern task title', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const legacyTitle = `Auto-improver: Recurring log pattern: ${pattern}`;
    const task = runCli(['task', 'new', legacyTitle, '--tag', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(task.status, 0, task.stderr || task.stdout);
    const taskPayload = JSON.parse(task.stdout);
    const taskRef = taskPayload.task?.display_id || taskPayload.task_id;
    assert.ok(taskRef);

    const dryRun = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const dryRunPayload = JSON.parse(dryRun.stdout);
    assert.equal(dryRunPayload.decision, 'existing_task_found');
    assert.equal(dryRunPayload.created_task.existing, true);
    assert.equal(dryRunPayload.created_task.task_ref, taskRef);
    assert.equal(dryRunPayload.next_command, `atris task show ${taskRef} --json`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake does not treat certified review as stale or unclear work', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: Array.from({ length: 13 }, (_, index) => ({
        display_id: `CLI-${index + 1}`,
        title: `Certified review needs proof for stale item ${index + 1}`,
        status: 'review',
        claimed_by: 'builder',
        metadata: {
          approval_status: 'pending',
          agent_certified: true,
        },
        review: {
          approval_status: 'pending',
          agent_certified: true,
        },
      })),
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const taskSignals = payload.auto_improver.scan.task_signals;
    assert.equal(taskSignals.review_task_count, 13);
    assert.equal(taskSignals.stale_task_count, 0);
    assert.equal(taskSignals.unclear_task_count, 0);
    assert.deepEqual(payload.auto_improver.scan.findings.filter((finding) => finding.source === 'task_truth'), []);
    assert.deepEqual(payload.auto_improver.scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake does not treat closed tasks as unclear work', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const stateDir = path.join(dir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: Array.from({ length: 13 }, (_, index) => ({
        display_id: `CLI-${index + 1}`,
        title: `Closed stale task needs proof ${index + 1}`,
        status: 'done',
        claimed_by: 'builder',
      })),
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const taskSignals = payload.auto_improver.scan.task_signals;
    assert.equal(taskSignals.unclear_task_count, 0);
    assert.deepEqual(payload.auto_improver.scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver unclear log finding carries line evidence', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    const logDate = recentLogDate();
    fs.writeFileSync(path.join(logsDir, `${logDate}.md`), [
      '# test log',
      ...Array.from({ length: 11 }, (_, index) => `needs owner for follow-up ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 11);
    assert.equal(scan.log_signals.unclear_next_actions.length, 5);
    assert.equal(scan.prevented_fire_candidate.source, 'unclear_next_actions');
    assert.equal(scan.prevented_fire_candidate.evidence[0].path, `atris/logs/${recentLogYear()}/${logDate}.md`);
    assert.equal(scan.prevented_fire_candidate.evidence[0].date, logDate);
    assert.equal(scan.prevented_fire_candidate.evidence[0].line, 2);
    assert.match(scan.prevented_fire_candidate.evidence[0].text, /needs owner for follow-up 1/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver log evidence keeps source line numbers after tail scan', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      ...Array.from({ length: 504 }, (_, index) => `filler ${index + 1}`),
      'needs owner after tail scan',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 1);
    assert.equal(scan.log_signals.unclear_next_actions[0].line, 506);
    assert.match(scan.log_signals.unclear_next_actions[0].text, /after tail scan/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver unclear log evidence favors recent dated logs', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      ...Array.from({ length: 10 }, (_, index) => `needs owner stale follow-up ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(recentLogsDir, { recursive: true });
    const recentDate = recentLogDate();
    fs.writeFileSync(path.join(recentLogsDir, `${recentDate}.md`), [
      '# recent log',
      'needs owner for current follow-up',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    // The 7-day recency filter drops the old May log entirely; only the
    // fresh log's single line survives, and it still wins the evidence slot.
    assert.equal(scan.log_signals.unclear_next_action_count, 1);
    assert.equal(scan.log_signals.unclear_next_actions.length, 1);
    assert.equal(scan.log_signals.unclear_next_actions[0].path, `atris/logs/${recentLogYear()}/${recentDate}.md`);
    // Old May log is filtered by recency; 1 unclear line stays under the >10
    // finding threshold, so there is no fire candidate to prevent anymore.
    assert.equal(scan.prevented_fire_candidate, null);
    assert.equal(scan.log_signals.unclear_next_actions[0].path, `atris/logs/${recentLogYear()}/${recentDate}.md`);
    assert.equal(scan.log_signals.unclear_next_actions[0].date, recentDate);
    assert.match(scan.log_signals.unclear_next_actions[0].text, /current follow-up/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver repeated failure evidence favors recent dated logs', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      ...Array.from({ length: 5 }, () => 'ERROR recurring sync failure'),
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(recentLogsDir, { recursive: true });
    const recentDate = recentLogDate();
    fs.writeFileSync(path.join(recentLogsDir, `${recentDate}.md`), [
      '# recent log',
      'ERROR recurring sync failure',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    // Old May log is filtered by recency; a single failure never reaches the
    // count >= 5 finding bar, so no fire candidate exists.
    assert.equal(scan.log_signals.repeated_failure_count, 0);
    assert.deepEqual(scan.log_signals.repeated_failures, []);
    assert.equal(scan.prevented_fire_candidate, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver repeated failure ties favor newest evidence', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      'ERROR recurring alpha failure',
      'ERROR recurring alpha failure',
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(recentLogsDir, { recursive: true });
    const recentDate = recentLogDate();
    fs.writeFileSync(path.join(recentLogsDir, `${recentDate}.md`), [
      '# recent log',
      'ERROR recurring beta failure',
      'ERROR recurring beta failure',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    // Old May alpha log is dropped by the recency filter; only beta survives.
    const failures = payload.auto_improver.scan.log_signals.repeated_failures;
    assert.equal(failures.length, 1);
    assert.match(failures[0].pattern, /beta/);
    assert.equal(failures[0].count, 2);
    assert.equal(failures[0].evidence[0].date, recentDate);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake ignores its own summary log residue', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'team', 'auto-improver', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# auto-improver log',
      ...Array.from({ length: 11 }, (_, index) => `- summary: CLI-275 adds auto-improver unclear log evidence ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 0);
    assert.deepEqual(scan.log_signals.unclear_next_actions, []);
    assert.deepEqual(scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake ignores blocked-to-ready receipt text', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      ...Array.from({ length: 11 }, (_, index) => `inspected blocked→ready receipt pair ${index + 1}`),
      'blocked until owner chooses next step',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 1);
    assert.equal(scan.log_signals.unclear_next_actions.length, 1);
    assert.equal(scan.log_signals.unclear_next_actions[0].date, recentLogDate());
    assert.match(scan.log_signals.unclear_next_actions[0].text, /blocked until owner/);
    assert.deepEqual(scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake skips journal append on identical no-op repeat', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    // Fixture named on the same local clock the wake journal uses
    // (todayLogName in commands/member.js): UTC-yesterday equals local-today
    // for hours each evening behind UTC, which made the fixture share the
    // journal's filename and get filtered out of the scan below.
    const fixtureDate = new Date();
    // A local day can be 25 hours when daylight saving time ends.
    fixtureDate.setDate(fixtureDate.getDate() - 1);
    const fixtureLogName = `${formatLocalDate(fixtureDate)}.md`;
    const fixtureLogRel = path.join(String(fixtureDate.getFullYear()), fixtureLogName);
    const logsDir = path.join(dir, 'atris', 'logs', String(fixtureDate.getFullYear()));
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    // Yesterday's date: inside the scanner's 7-day recency window, but distinct
    // from today's journal file where wake appends dogfood-scan entries.
    fs.writeFileSync(path.join(logsDir, fixtureLogName), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const wakeOnce = () => {
      const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
      assert.equal(wake.status, 0, wake.stderr || wake.stdout);
      return JSON.parse(wake.stdout);
    };

    const first = wakeOnce();   // creates the task → journaled
    assert.equal(first.decision, 'task_created');
    const second = wakeOnce();  // existing actionable task, prevented 0 → journaled (state changed)
    const third = wakeOnce();   // identical no-op repeat → receipt yes, journal no
    assert.equal(third.decision, second.decision);
    assert.equal(third.journal_skipped, 'duplicate_noop');
    assert.equal(third.log_path, null);
    assert.ok(fs.existsSync(third.receipt_path), 'receipt must still be written on skipped journal');

    // Scan every year dir: at the year boundary the journal lands in the new
    // year's dir while yesterday's fixture stays in the old one.
    const logsRoot = path.join(dir, 'atris', 'logs');
    const projectLogs = fs.readdirSync(logsRoot).flatMap((entry) => {
      const entryPath = path.join(logsRoot, entry);
      if (!fs.statSync(entryPath).isDirectory()) {
        return entry.endsWith('.md') ? [entryPath] : [];
      }
      return fs.readdirSync(entryPath)
        .filter((f) => f.endsWith('.md') && path.join(entry, f) !== fixtureLogRel)
        .map((f) => path.join(entryPath, f));
    });
    const journalText = projectLogs
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    const entryCount = (journalText.match(/## .* · Auto-improver dogfood scan/g) || []).length;
    assert.equal(entryCount, 2, `expected 2 journal entries (got ${entryCount}):\n${journalText}`);
  } finally {
    cleanupTempDir(dir);
  }
});


test('auto-improver wake ignores declared check verification lines (CLI-199)', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    // Wiki upkeep sweeps log one verification receipt per recompiled page.
    // These are success records — even when they contain failure-adjacent
    // words — and must never become recurring-failure candidates.
    const wikiDir = path.join(dir, 'atris', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const checkLine = '- check: `node bin/atris.js loop --dry-run --json` reports 0 failed pages instead of 13';
    fs.writeFileSync(path.join(wikiDir, 'log.md'), [
      '# wiki log',
      checkLine,
      checkLine,
      checkLine,
      checkLine,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const repeated = payload.auto_improver.scan.log_signals.repeated_failures || [];
    assert.deepEqual(
      repeated.filter((failure) => /loop --dry-run/.test(failure.pattern)),
      [],
      'check: verification lines must not count as repeated failures',
    );
  } finally {
    cleanupTempDir(dir);
  }
});


test('simple member alias reuses legacy problem-finding runtime', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'signal-scout', '--description="Turn repeated errors into bounded tasks"'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'problem-finder', '--json'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR alias path failed before problem-finder could scan logs';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const scriptPath = path.join(dir, 'scripts', 'scan-errors.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, `
import { readFileSync } from 'node:fs';
import path from 'node:path';
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
const filePath = path.join(root, 'atris', 'logs', '2026', '2026-06-07.md');
const lines = readFileSync(filePath, 'utf8').split(/\\r?\\n/);
const matches = lines.map((line, index) => ({ line, index })).filter((row) => /error|failed|crashed/i.test(row.line));
const selected = { pattern: '${pattern}', count: matches.length, evidence: matches.map((row) => ({ path: 'atris/logs/2026/2026-06-07.md', line: row.index + 1, text: row.line })) };
console.log(JSON.stringify({ ok: true, schema: 'atris.error_scan.v1', threshold: 3, selected, scanned: { files: 1, lines: lines.length, matching_lines: matches.length } }));
`, 'utf8');

    const wake = runCli(['member', 'wake', 'problem-finder', '--execute', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.mode, 'dry_run');
    assert.equal(payload.decision, 'create_task');
    assert.equal(payload.reason, 'autonomous_error_discovery:log_error_scan');
    assert.match(payload.next_command, /atris task new 'Fix recurring error:/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('wiki-miner wake builds wiki graph and wiki graph queries read it', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'wiki-miner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'wiki-miner', 'MEMBER.md'), [
      '---',
      'name: wiki-miner',
      'role: Knowledge Graph Builder',
      'description: Extracts entities and relationships from wiki using LLM',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Wiki Miner',
      '',
      'Extract entities and relationships from wiki pages.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'wiki-miner', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Maintain cross-domain knowledge graph for AGI reasoning.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'systems'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'systems', 'signals.md'), [
      '# Signal Loop',
      '',
      'signal-scout owns inbound feedback and uses the wiki graph to route AGI work.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.causal.json'), JSON.stringify({
      schema: 'atris.causal_patterns.v1',
      patterns: [
        { id: 'causal:signal', action: 'signal-scout proof packet', outcome: 'validator accepted proof', outcome_type: 'success' },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'wiki-miner', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_WIKI_MINER_LLM_JSON: JSON.stringify({
          entities: [
            { type: 'system', name: 'signal-scout' },
            { type: 'concept', name: 'wiki graph' },
          ],
          relationships: [
            { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'wiki_mine');
    assert.equal(payload.executed, true);
    assert.equal(payload.wiki_miner.llm_successful_pages, 1);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', '.graph.json')));
    assert.ok(fs.existsSync(payload.receipt_path));
    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.wiki_miner_tick.v1');
    assert.equal(receipt.pages_succeeded, 1);
    assert.equal(receipt.pages[0].llm_source, 'env_json');

    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), 'utf8'));
    assert.ok(graph.entities.some((entity) => entity.name === 'signal-scout' && entity.type === 'system'));
    assert.ok(graph.relationships.some((relationship) => relationship.from === 'signal-scout' && relationship.to === 'wiki graph'));
    assert.equal(graph.causal_patterns.length, 1);
    assert.equal(payload.wiki_miner.causal_pattern_count, 1);

    const related = runCli(['wiki', 'related', 'signal-scout', '--json'], { cwd: dir });
    assert.equal(related.status, 0, related.stderr || related.stdout);
    const relatedPayload = JSON.parse(related.stdout);
    assert.equal(relatedPayload.relationships.length, 1);
    assert.equal(relatedPayload.relationships[0].to, 'wiki graph');

    const entities = runCli(['wiki', 'entities', '--type', 'system', '--json'], { cwd: dir });
    assert.equal(entities.status, 0, entities.stderr || entities.stdout);
    const entitiesPayload = JSON.parse(entities.stdout);
    assert.deepEqual(entitiesPayload.entities.map((entity) => entity.name), ['signal-scout']);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'SECURITY.md'), [
      '# Security Readiness',
      '',
      'It uses Electron and IPC for release checks. They depend on canonical-root. What changed Here, and Everything points back to Security Readiness.',
      '',
    ].join('\n'), 'utf8');
    const heuristicWake = runCli(['member', 'wake', 'wiki-miner', '--execute', '--json'], { cwd: dir });
    assert.equal(heuristicWake.status, 0, heuristicWake.stderr || heuristicWake.stdout);
    const heuristicGraph = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), 'utf8'));
    const pronouns = new Set(['it', 'they']);
    const stopwords = new Set(['here', 'there', 'what', 'who', 'which', 'everything', 'nothing', 'something', 'anything', 'anyone', 'someone']);
    assert.equal(heuristicGraph.entities.some((entity) => pronouns.has(entity.name.toLowerCase()) || stopwords.has(entity.name.toLowerCase())), false);
    assert.equal(heuristicGraph.relationships.some((relationship) => (
      pronouns.has(relationship.from.toLowerCase()) || pronouns.has(relationship.to.toLowerCase())
    )), false);
    assert.equal(heuristicGraph.relationships.some((relationship) => (
      stopwords.has(relationship.from.toLowerCase()) || stopwords.has(relationship.to.toLowerCase())
      || relationship.from.toLowerCase() === relationship.to.toLowerCase()
    )), false);
    assert.ok(heuristicGraph.relationships.some((relationship) => (
      relationship.from === 'Security Readiness' && relationship.to === 'Electron'
    )));
  } finally {
    cleanupTempDir(dir);
  }
});


test('supervisor wake writes recommendations and query reads them', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'MEMBER.md'), [
      '---',
      'name: supervisor',
      'role: Meta-cognition Layer',
      'description: Monitors member performance and adjusts coordination',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Supervisor',
      '',
      'Monitor all member performance, identify patterns, suggest coordination adjustments.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Optimize member coordination through data-driven meta-cognition.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'signal-scout', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'signal-scout', 'logs', '2026-06-04.md'), [
      '## 09:00 - Wake',
      '- status: shipped two clean receipts',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'member-wake-signal-scout-2026-06-04T09-00-00-000Z.json'), JSON.stringify({
      schema: 'atris.member_wake.v1',
      created_at: new Date().toISOString(),
      member: 'signal-scout',
      ok: true,
      decision: 'wait',
      reason: 'tick_executed_experiment_proposed',
      duration_ms: 1200,
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_SUPERVISOR_LLM_JSON: JSON.stringify({
          top_performers: [
            { member: 'signal-scout', reason: 'Recent receipt succeeded quickly and log shows clean handoff.' },
          ],
          bottlenecks: [
            { issue: 'validator waits on proof packets', suggestion: 'Route proof-ready work through signal-scout first.' },
          ],
          recommendations: [
            { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Let signal-scout preflight proof packets before validation.' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'supervise');
    assert.equal(payload.executed, true);
    assert.equal(payload.supervisor.llm_successful, true);
    assert.equal(payload.supervisor.llm_source, 'env_json');
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json')));
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.supervisor_tick.v1');
    assert.equal(receipt.recommendation_count, 1);
    assert.equal(receipt.analysis.top_performers[0].member, 'signal-scout');

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'ok');
    assert.equal(recommendations.recommendations[0].to, 'signal-scout');

    const query = runCli(['member', 'supervisor', 'recommendations', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.recommendations.recommendations[0].reason, 'Let signal-scout preflight proof packets before validation.');
  } finally {
    cleanupTempDir(dir);
  }
});


test('supervisor wake keeps fallback recommendations when the llm call fails', () => {
  const dir = makeTempDir();
  try {
    seedSupervisorWakeFixture(dir);

    const wake = runCli(['member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_SUPERVISOR_LLM_JSON: '{not valid json',
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.supervisor.llm_successful, false);
    assert.equal(payload.supervisor.llm_error, 'invalid_json');

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'parse_error');
    assert.equal(recommendations.llm_source, 'env_json');
    assert.equal(recommendations.llm_error, 'invalid_json');
    assert.ok(recommendations.top_performers.length > 0, 'fallback analysis should keep heuristic content');
  } finally {
    cleanupTempDir(dir);
  }
});


test('supervisor llm call downgrades to the cloud endpoint when no local backend runs', async () => {
  // The supervisor postTurn used to pin route:'local', which made
  // pinLocalCheckout return true and skipped the local->cloud downgrade, so
  // any machine without a local backend died ECONNREFUSED. This stub stands
  // in for the cloud endpoint; the wake only reaches it if the downgrade fires.
  const dir = makeTempDir();
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({
        type: 'result',
        result: JSON.stringify({
          top_performers: [{ member: 'signal-scout', reason: 'stub cloud analysis' }],
          bottlenecks: [],
          recommendations: [{ type: 'priority', from: 'supervisor', to: 'signal-scout', reason: 'stub recommendation' }],
        }),
      }) + '\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cloudPort = server.address().port;
  // Bind then close a port so the local health probe has a guaranteed dead target.
  const deadPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  try {
    seedSupervisorWakeFixture(dir);

    const child = spawn(process.execPath, [cliPath, 'member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_SUPERVISOR_LLM: '1',
        OBELISK_LOCAL_ATRIS2_BACKEND_URL: `http://127.0.0.1:${deadPort}`,
        OBELISK_ATRIS2_BACKEND_URL: `http://127.0.0.1:${cloudPort}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr || stdout);
    assert.ok(
      requests.some((entry) => entry.method === 'POST' && entry.url === '/api/atris2/turn'),
      'expected the supervisor turn to reach the cloud stub via the downgrade',
    );

    const payload = JSON.parse(stdout);
    assert.equal(payload.supervisor.llm_source, 'atris2_backend');
    assert.equal(payload.supervisor.llm_successful, true);

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'ok');
    assert.equal(recommendations.top_performers[0].member, 'signal-scout');
  } finally {
    server.close();
    cleanupTempDir(dir);
  }
});


test('objective-generator wake writes scored proposal and query reads it', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
      'Use world model to identify valuable problems and propose objectives.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Identify and prioritize high-value problems autonomously.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), JSON.stringify({
      schema: 'atris.wiki_graph.v1',
      entities: [
        { type: 'system', name: 'signal-scout' },
        { type: 'concept', name: 'proof routing' },
      ],
      relationships: [
        { from: 'signal-scout', to: 'proof routing', type: 'uses' },
      ],
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), JSON.stringify({
      schema: 'atris.supervisor_recommendations.v1',
      status: 'ok',
      recommendations: [
        { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Preflight proof packets before review.' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:proof-routing',
          pattern: 'world graph signal -> proof packet preflight -> validator handoff',
          from_domain: 'coordination',
          transfer_score: 12,
          steps: ['world graph signal', 'proof packet preflight', 'validator handoff'],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_OBJECTIVE_GENERATOR_LLM_JSON: JSON.stringify({
          proposed_objective: 'Repair proof routing gaps around signal-scout',
          impact_score: 9,
          urgency_score: 8,
          alignment_score: 9,
          justification: 'signal-scout connects world graph evidence to validator handoff quality.',
          suggested_member: 'signal-scout',
          suggested_patterns: [
            { pattern: 'world graph signal -> proof packet preflight -> validator handoff', reason: 'matches proof routing' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'generate_objective');
    assert.equal(payload.executed, true);
    assert.equal(payload.objective_generator.llm_successful, true);
    assert.equal(payload.objective_generator.llm_source, 'env_json');
    assert.equal(payload.objective_generator.world_model_used, true);
    assert.equal(payload.objective_generator.transfer_pattern_count, 1);
    assert.equal(payload.objective_generator.task_created, true);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json')));
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.objective_generator_tick.v1');
    assert.equal(receipt.proposal.proposed_objective, 'Repair proof routing gaps around signal-scout');
    assert.equal(receipt.proposal.overall_score, 8.67);
    assert.equal(receipt.proposal.suggested_patterns[0].pattern, 'world graph signal -> proof packet preflight -> validator handoff');
    assert.equal(receipt.created_task.tag, 'auto-objective');

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.suggested_member, 'signal-scout');
    assert.equal(proposals.suggested_patterns[0].reason, 'matches proof routing');
    assert.equal(proposals.created_task.tag, 'auto-objective');

    const query = runCli(['member', 'objective-generator', 'proposals', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.proposal.proposed_objective, 'Repair proof routing gaps around signal-scout');
  } finally {
    cleanupTempDir(dir);
  }
});


test('objective-generator wake falls back to scored heuristic proposal without llm', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), JSON.stringify({
      schema: 'atris.wiki_graph.v1',
      entities: [
        { type: 'concept', name: 'wiki graph' },
        { type: 'system', name: 'signal-scout' },
      ],
      relationships: [
        { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
      ],
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), JSON.stringify({
      schema: 'atris.supervisor_recommendations.v1',
      status: 'ok',
      top_performers: [
        { member: 'signal-scout', reason: 'Recent member receipts succeeded and logs show clean handoffs.' },
      ],
      bottlenecks: [
        { issue: 'Review-ready work waits on proof packet routing', suggestion: 'Route proof packet preflight through signal-scout before validator review.' },
      ],
      recommendations: [
        { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Let signal-scout preflight proof packets before validation.' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:proof-routing',
          pattern: 'world graph signal -> proof packet preflight -> validator handoff',
          from_domain: 'coordination',
          transfer_score: 12,
          steps: ['world graph signal', 'proof packet preflight', 'validator handoff'],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.reason, 'heuristic_objective_proposal_written');
    assert.equal(payload.objective_generator.llm_successful, false);
    assert.equal(payload.objective_generator.llm_error, 'llm_not_configured');
    assert.equal(payload.objective_generator.task_created, false);

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.proposed_objective, 'Repair proof routing gaps around signal-scout wiki graph handoffs');
    assert.equal(proposals.overall_score, 7);
    assert.equal(proposals.suggested_member, 'signal-scout');
    assert.equal(proposals.suggested_patterns[0].pattern, 'world graph signal -> proof packet preflight -> validator handoff');
  } finally {
    cleanupTempDir(dir);
  }
});


test('objective-generator wake handles empty world model without task creation', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.reason, 'insufficient_world_model_data');
    assert.equal(payload.objective_generator.world_model_used, false);
    assert.equal(payload.objective_generator.task_created, false);

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'insufficient_world_model_data');
    assert.match(proposals.justification, /Insufficient world model data/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('generalist wake solves a restaurant domain without project-specific world model', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
      'Use world model, causal reasoning, and transfer learning to solve problems in any domain.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
      '## How To Choose Goals',
      '',
      '- Pick the next domain proof or reusable operating bottleneck.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:ops-bottleneck',
          pattern: 'bottleneck signal -> small controlled intervention -> outcome receipt',
          from_domain: 'operations',
          transfer_score: 11,
          steps: ['measure bottleneck', 'pilot one reversible change', 'review outcome receipt'],
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat neighborhood restaurant has slow seating during Friday dinner.',
      'Hosts manage walk-ins and reservations, servers cover uneven sections, and the kitchen gets order spikes.',
      'The team wants fewer guest complaints, lower wait time, less inventory waste, and no drop in service quality.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, true);
    assert.equal(payload.reason, 'heuristic_cross_domain_proof_written');
    assert.equal(payload.generalist.domain_name, 'restaurant operations');
    assert.equal(payload.generalist.domain_agnostic, true);
    assert.equal(payload.generalist.atris_specific_code_required, false);
    assert.equal(payload.generalist.capabilities_used.length, 8);
    assert.equal(payload.generalist.world_model_entities > 0, true);
    assert.equal(payload.generalist.world_model_relationships > 0, true);
    assert.equal(payload.generalist.objective_count > 0, true);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'generalist', 'proofs', 'latest.json')));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.generalist_tick.v1');
    assert.equal(receipt.proof.world_model.entities.some((entity) => entity.name === 'kitchen staff'), true);
    assert.match(receipt.top_objective.objective, /Reduce peak-service wait time/);
    assert.equal(receipt.proof.transfer_patterns[0].source_pattern, 'bottleneck signal -> small controlled intervention -> outcome receipt');
    assert.equal(/signal-scout|wiki-miner|objective-generator|Atris/.test(JSON.stringify(receipt.proof)), false);

    const query = runCli(['member', 'generalist', 'proof', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.proof.domain.name, 'restaurant operations');
    assert.equal(queryPayload.proof.capabilities_used.length, 8);
  } finally {
    cleanupTempDir(dir);
  }
});


test('generalist dry-run wake receipt does not name a proof file that was never written', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat neighborhood restaurant has slow seating during Friday dinner.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli([
      'member', 'wake', 'generalist',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, false);
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.generalist_tick.v1');
    assert.equal(receipt.proof_path, null);
    assert.equal(receipt.cross_domain_learning.run.proof_path, null);
    assert.match(receipt.cross_domain_learning.run.receipt_path, /^atris\/runs\/generalist-tick-.+\.json$/);

    const proofsDir = path.join(dir, 'atris', 'team', 'generalist', 'proofs');
    const writtenProofs = fs.existsSync(proofsDir) ? fs.readdirSync(proofsDir) : [];
    assert.deepEqual(writtenProofs, []);
  } finally {
    cleanupTempDir(dir);
  }
});


test('generalist wake scans domain files before existing task evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist', 'domains'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
      '## How To Choose Goals',
      '',
      '- Pick the next domain proof or reusable operating bottleneck.',
      '',
    ].join('\n'), 'utf8');
    assert.equal(runCli(['member', 'goal-from-mission', 'generalist', '--json'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-06-05T00:00:00.000Z',
      tasks: [
        {
          id: 'bakery-blocking-task',
          display_id: 'OBL-777',
          title: 'Existing task should wait until bakery domain proof is written',
          status: 'claimed',
          claimed_by: 'generalist',
          metadata: { assigned_to: 'generalist' },
          updated_at: Date.now(),
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'domains', 'bakery-operations.md'), [
      '# Bakery Operations',
      '',
      'A neighborhood bakery handles morning pastry demand, custom cake orders, wholesale pickups, oven capacity, proofing time, ingredient inventory, and front-counter queues.',
      'The bakery wants shorter morning wait time, fewer sold-out staples, lower waste, and calmer handoffs between bakers and counter staff.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'generalist', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, true);
    assert.equal(payload.generalist.domain_source_path, 'atris/team/generalist/domains/bakery-operations.md');
    assert.match(payload.generalist.domain_name, /Bakery Operations/i);
    assert.equal(payload.generalist.proof.domain.source_path, 'atris/team/generalist/domains/bakery-operations.md');
    assert.equal(payload.generalist.proof.world_model.entities.length > 0, true);
    assert.equal(payload.generalist.proof.objectives.length > 0, true);
    assert.match(payload.generalist.proof_path, /atris\/team\/generalist\/proofs\/bakery-operations-/);
    assert.ok(fs.existsSync(path.join(dir, payload.generalist.proof_path)));
    assert.doesNotMatch(payload.next_command, /task (delegate|note|show|review)/);

    const secondWake = runCli(['member', 'wake', 'generalist', '--json'], { cwd: dir });
    assert.equal(secondWake.status, 0, secondWake.stderr || secondWake.stdout);
    const secondPayload = JSON.parse(secondWake.stdout);
    assert.equal(secondPayload.decision, 'close_loop');
    assert.equal(secondPayload.reason, 'nearest_open_loop:task_projection:OBL-777');
  } finally {
    cleanupTempDir(dir);
  }
});


test('generalist wake learns restaurant pattern and reuses it for healthcare', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      'North Star: Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat restaurant has slow seating during Friday dinner.',
      'Hosts manage walk-ins and reservations, servers cover uneven sections, and the kitchen gets order spikes.',
      'The team wants fewer guest complaints, lower wait time, less inventory waste, and stable service quality.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'healthcare-domain.md'), [
      '# Healthcare Scheduling',
      '',
      'An outpatient clinic has long waits for urgent follow-ups.',
      'Schedulers balance provider calendars, room availability, authorization, urgency, no-show risk, and phone queues.',
      'The clinic wants faster access for high-risk patients, fewer idle slots, and lower staff stress.',
      '',
    ].join('\n'), 'utf8');

    const restaurant = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(restaurant.status, 0, restaurant.stderr || restaurant.stdout);
    const restaurantPayload = JSON.parse(restaurant.stdout);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.reused_pattern_count, 0);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.domains_solved_count, 1);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.pattern_count, 1);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.cross_domain_success_rate, 0);

    const libraryPath = path.join(dir, 'atris', 'wiki', '.cross_domain_patterns.json');
    assert.ok(fs.existsSync(libraryPath));
    const firstLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    assert.equal(firstLibrary.patterns.length, 1);
    assert.deepEqual(firstLibrary.patterns[0].domains, ['restaurant operations']);

    const healthcare = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'healthcare-domain.md',
      '--domain-name', 'healthcare scheduling',
      '--json',
    ], { cwd: dir });
    assert.equal(healthcare.status, 0, healthcare.stderr || healthcare.stdout);
    const healthcarePayload = JSON.parse(healthcare.stdout);
    assert.equal(healthcarePayload.generalist.cross_domain_patterns_scanned, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_pattern_matches.length, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.reused_pattern_count, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.learning_improved, true);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.domains_solved_count, 2);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.cross_domain_pattern_count, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.pattern_reuse_rate, 0.5);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.cross_domain_success_rate, 1);
    assert.match(healthcarePayload.generalist.proof.transfer_patterns[0].reason, /Reused cross-domain pattern/);
    assert.deepEqual(healthcarePayload.generalist.cross_domain_learning.reused_patterns[0].domains_before, ['restaurant operations']);

    const secondLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    assert.equal(secondLibrary.metrics.domains_solved_count, 2);
    assert.equal(secondLibrary.metrics.pattern_reuse_rate, 0.5);
    assert.equal(secondLibrary.metrics.cross_domain_success_rate, 1);
    assert.deepEqual(secondLibrary.patterns[0].domains, ['healthcare scheduling', 'restaurant operations']);
    assert.equal(secondLibrary.patterns[0].domain_count, 2);
    assert.equal(secondLibrary.patterns[0].success_rate, 1);

    const query = runCli(['member', 'generalist', 'patterns', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.library.metrics.domains_solved_count, 2);
    assert.equal(queryPayload.library.patterns[0].domain_count, 2);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake picks nearest open loop from task projection evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: '01TESTOPENLOOP',
          display_id: 'OBL-999',
          title: 'Close the nearest member loop',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778058000000,
        },
      ],
    }), 'utf8');

    const picked = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(picked.status, 0, picked.stderr || picked.stdout);
    const payload = JSON.parse(picked.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-999');
    assert.equal(payload.checks.has_open_loop_evidence, true);
    assert.equal(payload.checks.open_loop_source, 'task_projection');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-999');
    assert.match(payload.next_command, /atris task note OBL-999/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member wake scores strategic objective above low-value nearby loop', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'context'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'context', 'agi.md'), 'Cross-domain world model and transfer learning target.\n', 'utf8');
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'member', 'goal', 'command-leader',
      'Build AGI cross-domain world model from atris/context/agi.md',
      '--acceptance', 'Use atris/context/agi.md to set the next autonomous objective.',
      '--json',
    ], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'tiny-loop',
          display_id: 'OBL-301',
          title: 'Rename a small helper',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778057000000,
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'safe_next_bounded_step');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-301');
    assert.equal(payload.evidence.selected_wake_candidate.decision, 'tick');
    assert.equal(payload.evidence.wake_candidate_scores[0].decision, 'tick');
    assert.ok(payload.evidence.wake_candidate_scores.find((candidate) => candidate.task_ref === 'OBL-301'));
  } finally {
    cleanupTempDir(dir);
  }
});


test('member loop repeats wake quickly and skips an active lease', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions loop safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir }).status, 0);
    const loop = runCli([
      'member', 'loop', 'mission-lead',
      '--ticks', '2',
      '--interval', '0',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'loop');
    assert.equal(payload.status, 'completed');
    assert.equal(payload.ticks, 2);
    assert.equal(payload.mode, 'execute');
    // Fallback proposals are unreviewable, so tick 2 does not wait on tick
    // 1's proposal (that deadlocked members for weeks); it proposes again and
    // the stale fallback is superseded. One open proposal stays the invariant.
    assert.equal(payload.decisions['wait:tick_executed_experiment_proposed'], 2);
    assert.equal(payload.decisions['wait:open_experiment_proposed'], undefined);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(payload.log_path));
    assert.ok(fs.existsSync(payload.latest_path));
    const latest = JSON.parse(fs.readFileSync(payload.latest_path, 'utf8'));
    assert.equal(latest.receipt_path, payload.receipt_path);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    const experiments = state.goals[0].experiments;
    assert.equal(experiments.length, 2);
    assert.equal(experiments.filter((experiment) => experiment.status === 'proposed').length, 1, 'exactly one open proposal');
    assert.equal(experiments[0].status, 'superseded');
    assert.equal(experiments[0].superseded_reason, 'unreviewable_fallback_replaced_by_next_proposal');

    const status = runCli(['member', 'loop', 'mission-lead', '--status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.active, false);
    assert.equal(statusPayload.latest.receipt_path, payload.receipt_path);

    const loopStateDir = path.join(dir, '.atris', 'state', 'member-loops');
    fs.mkdirSync(loopStateDir, { recursive: true });
    fs.writeFileSync(path.join(loopStateDir, 'mission-lead.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'mission-lead',
      run_id: 'active-run',
      pid: process.pid,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 60000,
    }, null, 2));

    const skipped = runCli(['member', 'loop', 'mission-lead', '--ticks', '1', '--interval', '0', '--json'], { cwd: dir });
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    const skippedPayload = JSON.parse(skipped.stdout);
    assert.equal(skippedPayload.status, 'skipped');
    assert.equal(skippedPayload.reason, 'loop_already_active');
    assert.equal(skippedPayload.ticks, 0);
    assert.ok(fs.existsSync(skippedPayload.receipt_path));

    fs.rmSync(path.join(loopStateDir, 'mission-lead.lock.json'), { force: true });
    fs.writeFileSync(path.join(loopStateDir, 'mission-lead.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'mission-lead',
      run_id: 'dead-run',
      pid: 99999999,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 60000,
    }, null, 2));

    const recovered = runCli(['member', 'loop', 'mission-lead', '--ticks', '1', '--interval', '0', '--json'], { cwd: dir });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredPayload = JSON.parse(recovered.stdout);
    assert.notEqual(recoveredPayload.status, 'skipped');
    assert.notEqual(recoveredPayload.reason, 'loop_already_active');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member loop early-exits after two identical ask decisions in dry-run mode', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'architect'], { cwd: dir }).status, 0);
    // Overwrite MISSION.md with the literal placeholder North Star so every wake tick returns
    // the same ask:mission_missing_or_placeholder decision — this used to burn all 10 ticks
    // re-asking (live bug OBL 2026-07-16) because the idle early-exit only ran under --execute.
    fs.writeFileSync(
      path.join(dir, 'atris', 'team', 'architect', 'MISSION.md'),
      '# Mission\n\n## North Star\n\nDefine why this member exists and how it chooses goals.\n\n## How To Choose Goals\n\n- placeholder\n',
      'utf8',
    );

    const loop = runCli([
      'member', 'loop', 'architect',
      '--ticks', '10',
      '--interval', '0',
      '--json',
    ], { cwd: dir });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'loop');
    assert.equal(payload.mode, 'dry_run');
    assert.equal(payload.ticks, 2, 'should stop after the 2nd identical ask, not run all 10 ticks');
    assert.equal(payload.status, 'blocked_on_human');
    assert.equal(payload.blocked_on_human, true);
    assert.equal(payload.early_exit.stop, 'repeated_identical_ask');
    assert.equal(payload.early_exit.reason, 'mission_missing_or_placeholder');
    assert.ok(payload.next_command);
    assert.equal(payload.decisions['ask:mission_missing_or_placeholder'], 2);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member alive supports hourly forever contract with a stop command', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions loop safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const alive = runCli([
      'member', 'alive', 'mission-lead',
      '--hourly',
      '--forever',
      '--ticks', '1',
      '--json',
    ], { cwd: dir });
    assert.equal(alive.status, 0, alive.stderr || alive.stdout);
    const payload = JSON.parse(alive.stdout);
    assert.equal(payload.action, 'alive');
    assert.equal(payload.cadence, 'hourly');
    assert.equal(payload.forever, true);
    assert.equal(payload.interval_ms, 3600000);
    assert.equal(payload.ticks_requested, 1);
    assert.equal(payload.stop_command, 'atris member alive mission-lead --stop');
    assert.match(payload.operating_contract, /choose useful work/);
    assert.match(payload.operating_contract, /instead of faking activity/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member alive install dry-run writes hourly cron plan without touching crontab', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);

    const install = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--dry-run',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.action, 'alive_install');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.installed, false);
    assert.equal(payload.cadence, 'hourly');
    assert.equal(payload.forever, true);
    assert.match(payload.crontab_line, /ATRIS_MEMBER_ALIVE_MISSION_LEAD/);
    assert.match(payload.crontab_line, /23 \* \* \* \*/);
    assert.equal(payload.preview.member, 'mission-lead');
    assert.equal(payload.preview.cadence, '23 * * * *');
    assert.match(payload.preview.mission_text, /Run mission-lead on meaningful work/);
    assert.match(payload.preview.run, /member' 'alive' 'mission-lead'/);
    assert.equal(payload.preview.verify, 'atris member alive mission-lead --status --json');
    assert.match(payload.preview.stop_when, /atris member alive mission-lead --uninstall/);
    assert.match(payload.preview.receipts, /\.atris\/state\/member-loops\/logs$/);
    assert.deepEqual(payload.command.slice(-7), [
      '--hourly',
      '--forever',
      '--ticks',
      '1',
      '--json',
      '--execute',
      '--confirm-autonomy-policy',
    ]);
    assert.equal(payload.stop_command, 'atris member alive mission-lead --uninstall');
    assert.ok(fs.existsSync(payload.script_path));
    const script = fs.readFileSync(payload.script_path, 'utf8');
    assert.match(script, /member' 'alive' 'mission-lead'/);
    assert.match(script, /--ticks' '1'/);

    const humanInstall = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--dry-run',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
    ], { cwd: dir });
    assert.equal(humanInstall.status, 0, humanInstall.stderr || humanInstall.stdout);
    assert.match(humanInstall.stdout, /Every hour this will:/);
    assert.match(humanInstall.stdout, /verify: atris member alive mission-lead --status --json/);
    assert.match(humanInstall.stdout, /receipts: .*\.atris\/state\/member-loops\/logs/);

    const status = runCli(['member', 'alive', 'mission-lead', '--status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.hourly_alive.script_exists, true);
    assert.equal(statusPayload.hourly_alive.installed, false);
    assert.equal(statusPayload.hourly_alive.install_command, 'atris member alive mission-lead --install --hourly --forever --execute --confirm-autonomy-policy --json');
    assert.equal(statusPayload.hourly_alive.uninstall_command, 'atris member alive mission-lead --uninstall');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member alive install blocks execute on dirty git', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runGit(['init', '-q'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-qm', 'baseline'], dir).status, 0);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted install risk\n');

    const install = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(install.status, 1, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.action, 'alive_install');
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'install_requires_clean_git');
    assert.equal(payload.git.dirty, true);
    assert.ok(payload.git.dirty_files.some((line) => /dirty\.txt/.test(line)));
    assert.equal(payload.preview.verify, 'atris member alive mission-lead --status --json');
    assert.equal(fs.existsSync(payload.preview.receipts), false);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member alive install without confirmation exits 1', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const install = runCli([
      'member', 'alive', 'mission-lead', '--install', '--execute', '--json',
    ], { cwd: dir });
    assert.equal(install.status, 1, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'execute_requires_confirm_autonomy_policy');
  } finally {
    cleanupTempDir(dir);
  }
});


test('member status exposes blocked asks before more loop work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'ops'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal', 'ops', 'Keep the business loop moving', '--acceptance', 'one operator-useful action'], { cwd: dir }).status, 0);
    const tick = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const experimentId = JSON.parse(tick.stdout).experiment.id;

    const blocked = runCli([
      'member', 'block', 'ops', experimentId,
      '--reason', 'needs customer authority',
      '--ask', 'Approve contacting the customer?',
      '--orchestrator', 'team-hub',
      '--json',
    ], { cwd: dir });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.needs_user, true);
    assert.equal(blockedPayload.experiment.status, 'blocked');
    assert.equal(blockedPayload.experiment.block.orchestrator, 'team-hub');

    const status = runCli(['member', 'status', 'ops', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.state, 'needs_user');
    assert.equal(statusPayload.needs_user, true);
    assert.equal(statusPayload.ask, 'Approve contacting the customer?');
    assert.match(statusPayload.next_command, /member review ops/);
    assert.ok(statusPayload.recent_log.some((line) => /Approve contacting the customer/.test(line)));

    const paused = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);
    const pausedPayload = JSON.parse(paused.stdout);
    assert.equal(pausedPayload.action, 'blocked');
    assert.equal(pausedPayload.experiment.id, experimentId);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'ops', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});


test('member block refuses discarded experiments', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'ops'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal', 'ops', 'Keep discarded work closed'], { cwd: dir }).status, 0);
    const tick = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const experimentId = JSON.parse(tick.stdout).experiment.id;

    const discarded = runCli([
      'member', 'review', 'ops', experimentId,
      '--discard',
      '--proof', 'discarded because the experiment was not useful',
      '--json',
    ], { cwd: dir });
    assert.equal(discarded.status, 0, discarded.stderr || discarded.stdout);

    const blocked = runCli([
      'member', 'block', 'ops', experimentId,
      '--reason', 'late blocker',
      '--ask', 'Should not reopen discarded work',
      '--json',
    ], { cwd: dir });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /already discarded/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'ops', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
    assert.equal(state.goals[0].experiments[0].status, 'discarded');
    assert.equal(state.goals[0].experiments[0].proof, 'discarded because the experiment was not useful');
  } finally {
    cleanupTempDir(dir);
  }
});
