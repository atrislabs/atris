'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const comms = require('../lib/swarm-comms');
const { swarmCommand } = require('../commands/swarm');
const worktreeCore = require('../lib/worktree-core');
const commandsAutoland = require('../commands/autoland');
const autoland = require('../lib/autoland');
const { checkCommand } = require('../commands/check');
const { SKILL_EVAL_SCHEMA, appendSkillEvalReceipt, changedSkillFiles, skillEvalGate } = require('../lib/skill-eval-gate');
const { evaluateAutoAccept } = require('../lib/auto-accept-certified');
const { landStaleGreenBranches } = require('../lib/land-green');
const { hasNodeSqlite: probeNodeSqlite } = require('./helpers/node-sqlite');
const hasNodeSqlite = () => probeNodeSqlite({ NODE_NO_WARNINGS: '1' });

function mkTmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function git(cwd, args, env = process.env) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr || res.stdout}`);
  return String(res.stdout || '').trim();
}

function runCli(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...extraEnv };
  delete env.ATRIS_RUNNER_PROFILE;
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env,
  });
  if (res.error) throw res.error;
  return res;
}

function runCliAsync(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...extraEnv };
  delete env.ATRIS_RUNNER_PROFILE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// =========================================================================
// Bug 1: Isolated swarm worker preserves work on missing git identity &
// never destroys verified work or reports done when git commit fails.
// =========================================================================

test('Bug 1: isolated swarm worker commits without git identity and preserves worktree & reports failed when git commit fails', async (t) => {
  const dir = mkTmp(t, 'atris-bug1-swarm-');
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris', 'team', 'coordinator'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'coordinator', 'MEMBER.md'), '# coordinator\n');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'add', '.']);
  git(root, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'seed']);

  const tasks = new Map([
    ['t-noid', { task_key: 't-noid', content: 'Commit with no git identity', status: 'open', channel: 'general' }],
    ['t-hookfail', { task_key: 't-hookfail', content: 'Commit fails hook', status: 'open', channel: 'general' }],
  ]);
  const reports = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/health') return send(200, { status: 'ok' });
      if (req.url === '/api/register') return send(201, { member_id: parsed.member_id, api_key: `tok-${parsed.member_id}`, hub_id: parsed.hub_id });
      if (/\/posts$/.test(req.url) && req.method === 'POST') return send(201, { post_id: 'p-1' });
      if (/\/touch$/.test(req.url)) return send(200, { ok: true });
      if (/\/briefing$/.test(req.url)) return send(200, { posts: [] });
      if (/\/posts\?/.test(req.url)) return send(200, { posts: [] });
      if (/\/ready/.test(req.url)) return send(200, { tasks: [] });
      if (/\/unclaimed/.test(req.url)) {
        const open = [...tasks.values()].filter((x) => x.status === 'open');
        return send(200, { count: open.length, tasks: open });
      }
      if (/\/claim$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (!item || item.status !== 'open') return send(409, { detail: 'taken' });
        item.status = 'claimed';
        return send(201, { task_key: item.task_key, status: 'claimed' });
      }
      if (/\/report(\/once)?$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (item) item.status = parsed.status;
        reports.push(parsed);
        return send(200, { task_key: parsed.task_key, status: parsed.status });
      }
      if (/\/liveness/.test(req.url)) return send(200, { alive: [], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: [] });
      if (/\/idle/.test(req.url)) return send(200, { idle: [] });
      if (/\/claims$/.test(req.url)) return send(200, { count: 0, claims: [] });
      if (/\/members$/.test(req.url)) return send(200, { count: 1, members: [] });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  assert.equal(await swarmCommand(['start', 'Bug 1 test', '--team', 'builder', '--server', url, '--hub', 'hb1', '--json'], { root, home, log: () => {} }), 0);

  // 1a) Strip git global/system config so user.name/user.email are unset -> must still commit via fallback identity!
  const savedGitEnv = {
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'empty-gitconfig');
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  try {
    // Only claim t-noid first by temporarily marking t-hookfail closed
    tasks.get('t-hookfail').status = 'done';
    const resNoId = await comms.runSwarmUpLoop(root, {
      durationMs: 60000,
      once: true,
      exec: `node -e "require('fs').writeFileSync('verified-noid.txt', 'preserved')"`,
      verify: `node -e "process.exit(require('fs').readFileSync('verified-noid.txt','utf8')==='preserved'?0:1)"`,
      server: url,
      hub: 'hb1',
      home,
      json: true,
    });
    assert.equal(resNoId.ok, true, JSON.stringify(resNoId));
    const stepNoId = resNoId.history[0].steps[0];
    assert.ok(stepNoId.branch, 'must preserve verified work on a branch even without git user.name/email');
    assert.ok(stepNoId.commit, 'must record commit sha');
    assert.equal(git(root, ['show', `${stepNoId.branch}:verified-noid.txt`]), 'preserved');
    assert.equal(reports.at(-1).status, 'done');

    // 1b) Failing pre-commit hook: commit fails -> worktree & branch MUST NOT be destroyed, and Swarlo MUST receive status='failed'!
    const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookFile, '#!/bin/sh\necho "hook rejected commit" >&2\nexit 1\n', { mode: 0o755 });
    tasks.get('t-hookfail').status = 'open';
    const resFail = await comms.runSwarmUpLoop(root, {
      durationMs: 60000,
      once: true,
      exec: `node -e "require('fs').writeFileSync('precious.txt', 'do-not-delete')"`,
      verify: `node -e "process.exit(require('fs').readFileSync('precious.txt','utf8')==='do-not-delete'?0:1)"`,
      server: url,
      hub: 'hb1',
      home,
      json: true,
    });
    assert.equal(resFail.ok, false, 'commit failure must fail the loop step');
    const stepFail = resFail.history[0].steps[0];
    assert.equal(stepFail.ok, false, 'step must be ok=false when commit fails');
    assert.equal(reports.at(-1).task_key, 't-hookfail');
    assert.equal(reports.at(-1).status, 'failed', 'Swarlo must receive failed, never done, when commit fails');

    // Verified file MUST still survive on disk in the kept worktree and its branch must still exist!
    const wtBase = path.join(root, '.atris', 'swarm-worktrees');
    const keptDirs = fs.existsSync(wtBase) ? fs.readdirSync(wtBase) : [];
    assert.ok(keptDirs.length >= 1, 'isolated worktree must not be force-deleted on commit failure');
    const surviving = keptDirs.map((d) => path.join(wtBase, d, 'precious.txt')).find((p) => fs.existsSync(p));
    assert.ok(surviving, 'precious.txt must still exist in the preserved worktree');
    assert.equal(fs.readFileSync(surviving, 'utf8'), 'do-not-delete');
    const branches = git(root, ['branch', '--list', 'swarm/*t-hookfail*']);
    assert.ok(branches.trim().length > 0, 'temp branch must not be deleted on commit failure');
  } finally {
    for (const [k, v] of Object.entries(savedGitEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// =========================================================================
// Bug 2: worktree ship --local --merge on repo without origin + dirty check
// before git switch.
// =========================================================================

test('Bug 2: worktree ship --local --merge works without origin and checks primary dirt before switching branches', (t) => {
  const dir = mkTmp(t, 'atris-bug2-ship-');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# local only\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);

  // 2a) No origin, no --target: ship --local --merge must merge cleanly into master instead of running `git switch HEAD`!
  const wt1 = path.join(dir, 'wt-local-merge');
  const started1 = runCli(['worktree', 'start', '--agent', 'builder', '--task', 'local-merge', '--path', wt1, '--no-deps'], repo);
  assert.equal(started1.status, 0, started1.stderr || started1.stdout);
  fs.appendFileSync(path.join(wt1, 'README.md'), 'merged without origin\n');

  const shipped1 = runCli([
    'worktree', 'ship', '--local', '--merge',
    '--message', 'ship without origin',
    '--verify', 'git status --short',
    '--keep-copy',
  ], wt1);
  assert.equal(shipped1.status, 0, `stderr:\n${shipped1.stderr}\nstdout:\n${shipped1.stdout}`);
  assert.match(shipped1.stdout, /merge: merged \(local mode\)/);
  assert.match(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), /merged without origin/);

  // 2b) Dirty primary on a different branch: ship --local --merge must fail BEFORE switching primary off side-branch!
  git(repo, ['switch', '-q', '-c', 'side-branch']);
  fs.writeFileSync(path.join(repo, 'uncommitted-work.txt'), 'keep me on side-branch\n');

  const wt2 = path.join(dir, 'wt-dirty-primary');
  const started2 = runCli(['worktree', 'start', '--agent', 'builder', '--task', 'dirty-check', '--base', 'master', '--path', wt2, '--no-deps'], repo);
  assert.equal(started2.status, 0, started2.stderr || started2.stdout);
  fs.appendFileSync(path.join(wt2, 'README.md'), 'second change\n');

  const shipped2 = runCli([
    'worktree', 'ship', '--local', '--merge', '--target', 'master',
    '--message', 'should fail dirty primary',
    '--verify', 'git status --short',
    '--keep-copy',
  ], wt2);
  assert.notEqual(shipped2.status, 0, 'dirty primary must block local merge');
  assert.match(shipped2.stderr + shipped2.stdout, /primary checkout dirty/);
  assert.equal(git(repo, ['branch', '--show-current']), 'side-branch', 'primary must NOT be switched before failing dirty check');
});

// =========================================================================
// Bug 3: Duplicate-flight guard for hyphenated members & -2 suffixes.
// =========================================================================

test('Bug 3: duplicate-flight guard catches same-second -2 suffixes and hyphenated member names', (t) => {
  const suffixed = worktreeCore.parseAgentFlightName('codex/cursor-fix-auth-20260809-175253-2');
  assert.ok(suffixed, 'must parse same-second -2 suffix');
  assert.equal(suffixed.taskSlug, 'fix-auth');
  assert.equal(worktreeCore.collidingFlights([suffixed], 'fix-auth').length, 1);

  const hyphenated = worktreeCore.parseAgentFlightName('codex/replay-lead-fix-auth-20260809-175253');
  assert.ok(hyphenated);
  assert.equal(worktreeCore.collidingFlights([hyphenated], 'fix-auth', { knownMembers: ['replay-lead'] }).length, 1, 'replay-lead must collide on fix-auth');

  const hyphenatedSuffixed = worktreeCore.parseAgentFlightName('codex/auto-improver-dispatch-cli-900-20260809-181000-2');
  assert.ok(hyphenatedSuffixed);
  assert.equal(worktreeCore.collidingFlights([hyphenatedSuffixed], 'dispatch-cli-900', { knownMembers: ['auto-improver'] }).length, 1);
  assert.equal(worktreeCore.collidingFlights([hyphenatedSuffixed], 'dispatch-cli-901', { knownMembers: ['auto-improver'] }).length, 0);

  // End-to-end: start worktree as hyphenated member `replay-lead`, then attempt duplicate as `mission-lead`
  const dir = mkTmp(t, 'atris-bug3-dup-');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# dup\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);

  const wt1 = path.join(dir, 'wt-1');
  const first = runCli(['worktree', 'start', '--member', 'replay-lead', '--task', 'fix auth login', '--path', wt1, '--no-deps'], repo);
  assert.equal(first.status, 0, first.stderr || first.stdout);

  const wt2 = path.join(dir, 'wt-2');
  const second = runCli(['worktree', 'start', '--member', 'mission-lead', '--task', 'fix auth login', '--path', wt2, '--no-deps'], repo);
  assert.equal(second.status, 2, `duplicate flight must be refused:\n${second.stdout}\n${second.stderr}`);
  assert.match(second.stderr, /overlapping flight/);
});

// =========================================================================
// Bug 4: autoland on preserves saved policy & tick accumulates receipt.alarms.
// =========================================================================

test('Bug 4: autoland on preserves saved imessage_to & switches, and tick accumulates receipt.alarms', async (t) => {
  const dir = mkTmp(t, 'atris-bug4-autoland-');
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'README.md'), '# autoland\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'init']);

  const fakeSched = {
    platform: 'linux',
    homeDir: home,
    uid: 501,
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
  };

  const origLog = console.log;
  console.log = () => {};
  try {
    commandsAutoland.turnOn(root, [
      '--as', 'keshav',
      '--to', '+15551234567',
      '--digest-hour', '9',
      '--alarm-hours', '12',
      '--all',
      '--no-strict-verify',
      '--include-protected',
    ], { scheduler: fakeSched });

    // Re-running plain `autoland on` must NOT wipe any previously configured setting!
    commandsAutoland.turnOn(root, [], { scheduler: fakeSched });
    const afterPlain = autoland.readPolicy(root);
    assert.equal(afterPlain.imessage_to, '+15551234567');
    assert.equal(afterPlain.digest_hour, 9);
    assert.equal(afterPlain.alarm_hours, 12);
    assert.equal(afterPlain.accept_all, true);
    assert.equal(afterPlain.strict_verify, false);
    assert.equal(afterPlain.accept_protected, true);

    // Explicitly passing --to updates imessage_to without wiping the rest.
    commandsAutoland.turnOn(root, ['--to', '+15559990000'], { scheduler: fakeSched });
    const afterUpdate = autoland.readPolicy(root);
    assert.equal(afterUpdate.imessage_to, '+15559990000');
    assert.equal(afterUpdate.digest_hour, 9);
    assert.equal(afterUpdate.alarm_hours, 12);
    assert.equal(afterUpdate.accept_all, true);
    assert.equal(afterUpdate.strict_verify, false);
  } finally {
    console.log = origLog;
  }

  // 4b) receipt.alarms must accumulate instead of overwriting existing alarms!
  if (!hasNodeSqlite()) return;
  const taskDb = require('../lib/task-db');
  const dbPath = path.join(root, '.atris', 'fixture.db');
  const db = taskDb.open(dbPath);
  const staleMs = Date.now() - 48 * 3600 * 1000;
  const staleReviewAt = new Date(staleMs).toISOString();
  const added = taskDb.addTask(db, {
    title: 'Waiting billing task past alarm threshold',
    tag: 'billing',
    workspaceRoot: fs.realpathSync(root),
    status: 'review',
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: 'node --check README.md passed',
    },
  });
  db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(staleMs, staleMs, added.id);
  const projection = taskDb.taskProjection(db, { workspaceRoot: fs.realpathSync(root) });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify(projection, null, 2));
  taskDb.close(db);

  const origSend = autoland.sendImessage;
  const savedDb = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  autoland.sendImessage = () => ({ ok: true, output: 'sent' });
  try {
    const policy = {
      enabled: true,
      enabled_by: 'keshav',
      imessage_to: '+15559990000',
      alarm_hours: 12,
      digest_hour: (new Date().getHours() + 12) % 24,
      daily_experiment: false,
      janitor: false,
      check_reroute: false,
      checked_merged_done: false,
    };
    autoland.writePolicy(root, policy);
    const receipt = { at: new Date().toISOString(), landed: [], alarms: 2, digest_sent: false, enabled: true };
    await commandsAutoland.runTickBody(root, { json: false, policy, receipt });
    assert.equal(receipt.alarms, 3, 'receipt.alarms must add due.length to existing alarms (2 + 1 = 3), not overwrite with 1');
  } finally {
    autoland.sendImessage = origSend;
    if (savedDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = savedDb;
  }
});

// =========================================================================
// Bug 5: atris check fix resolves own bin/atris.js & rolls back on spawn null.
// =========================================================================

test('Bug 5: atris check fix rolls back dispatch lock when spawn fails (status null) and launches own bin when atris not on PATH', async (t) => {
  const dir = mkTmp(t, 'atris-bug5-checkfix-');
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, ['init', '--quiet', '--bare', '--initial-branch=master', remote]);
  git(dir, ['init', '--quiet', '--initial-branch=master', root]);
  git(root, ['config', 'user.name', 'check test']);
  git(root, ['config', 'user.email', 'check@example.test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  git(root, ['config', `url.${remote}.insteadOf`, 'https://github.com/acme/app.git']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'fail.js'), "console.log('broken'); process.exit(1);\n");
  fs.writeFileSync(path.join(root, 'src', 'f.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'atris', 'checks.json'), JSON.stringify({
    checks: { feature: { run: 'node fail.js', when: ['src/**'] }, full: { run: 'node ok.js' } },
    default: ['full'],
  }, null, 2));
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'start']);
  git(root, ['push', '--quiet', 'origin', 'master']);
  git(root, ['remote', 'set-head', 'origin', 'master']);
  git(root, ['switch', '--quiet', '-c', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'f.js'), 'module.exports = 2;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'change\n\nProof: node ok.js']);

  const saved = { PATH: process.env.PATH, ATRIS_CHECK_PERSON: process.env.ATRIS_CHECK_PERSON };
  process.env.ATRIS_CHECK_PERSON = '1';
  try {
    const checkOut = [];
    const checked = await checkCommand([], { cwd: root, log: (l) => checkOut.push(String(l)) });
    assert.equal(checked, 1, checkOut.join('\n'));

    // 5a) Simulate real spawn failure (status === null) via broken interpreter shebang in fake-bin/atris!
    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeAtris = path.join(fakeBin, 'atris');
    fs.writeFileSync(fakeAtris, '#!/nonexistent-interpreter-for-bug5-test\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH}`;

    const firstLogs = [];
    const first = await checkCommand(['fix'], { cwd: root, log: (l) => firstLogs.push(String(l)) });
    assert.equal(first, 1, 'spawn failure must return exit 1');

    // Receipt and fix-dispatched.json MUST be rolled back so retry is NOT permanently locked out!
    const receiptsDir = path.join(root, '.atris', 'receipts');
    const receiptFile = path.join(receiptsDir, fs.readdirSync(receiptsDir).find((f) => f.startsWith('check-')));
    const afterFailReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(afterFailReceipt.fix_dispatched_at, undefined, 'fix_dispatched_at must be rolled back when spawn fails');
    const ledgerFile = path.join(receiptsDir, 'fix-dispatched.json');
    const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {};
    assert.equal(ledger[afterFailReceipt.tree], undefined, 'fix-dispatched.json must remove tree when spawn fails');

    // 5b) Now fix the fake-bin script and retry -> retry MUST succeed (not rejected as "one fix job per receipt")!
    const callsLog = path.join(dir, 'calls.log');
    fs.writeFileSync(fakeAtris, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(callsLog)}\necho COMMIT=abc123\n`, { mode: 0o755 });
    const retryLogs = [];
    const retry = await checkCommand(['fix'], { cwd: root, log: (l) => retryLogs.push(String(l)) });
    assert.equal(retry, 0, retryLogs.join('\n'));
    assert.ok(fs.existsSync(callsLog), 'retry after rollback must actually launch');

    // 5c) With NO `atris` on PATH at all (only system /usr/bin:/bin), spawning must NOT hit ENOENT (it invokes process.execPath + bin/atris.js)!
    fs.unlinkSync(fakeAtris);
    fs.writeFileSync(receiptFile, JSON.stringify({ ...afterFailReceipt }, null, 2));
    fs.writeFileSync(ledgerFile, '{}\n');
    process.env.PATH = '/usr/bin:/bin';
    const noPathLogs = [];
    const noPathRes = await checkCommand(['fix'], { cwd: root, log: (l) => noPathLogs.push(String(l)) });
    // bin/atris.js computer pr fails cleanly with non-null exit (not ENOENT spawn error / not locked out with status null)
    const noPathText = noPathLogs.join('\n');
    assert.doesNotMatch(noPathText, /ENOENT|spawn atris|could not launch/, noPathText);
    assert.ok(noPathRes === 0 || noPathRes === 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// =========================================================================
// Bug 6: engine shorthand flags & bench/test structured error handling.
// =========================================================================

test('Bug 6: engine <name> --json/--global/--help do not hijack to ask, and bench/test return exit 2 cleanly', (t) => {
  const root = mkTmp(t, 'atris-bug6-engine-');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });

  // 6a) atris engine codex --help prints help and does NOT write .atris/engine.json
  const helpRes = runCli(['engine', 'codex', '--help'], root);
  assert.equal(helpRes.status, 0, helpRes.stderr || helpRes.stdout);
  assert.match(helpRes.stdout, /atris engine/);
  assert.equal(fs.existsSync(path.join(root, '.atris', 'engine.json')), false, '--help must not mutate default engine');

  // 6b) atris engine codex --json switches default and emits valid JSON!
  const jsonSet = runCli(['engine', 'codex', '--json'], root);
  assert.equal(jsonSet.status, 0, jsonSet.stderr || jsonSet.stdout);
  const parsedSet = JSON.parse(jsonSet.stdout.slice(jsonSet.stdout.indexOf('{')));
  assert.equal(parsedSet.ok, true);
  assert.equal(parsedSet.default, 'codex');

  // 6c) atris engine claude --global writes to isolated HOME/.atris/engine.json instead of workspace .atris/engine.json!
  const fakeHome = mkTmp(t, 'atris-bug6-home-');
  const globalSet = runCli(['engine', 'claude', '--global'], root, { HOME: fakeHome, USERPROFILE: fakeHome });
  assert.equal(globalSet.status, 0, globalSet.stderr || globalSet.stdout);
  const globalSaved = JSON.parse(fs.readFileSync(path.join(fakeHome, '.atris', 'engine.json'), 'utf8'));
  assert.equal(globalSaved.default, 'claude', '--global must write ~/.atris/engine.json');
  const wsSaved = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'engine.json'), 'utf8'));
  assert.equal(wsSaved.default, 'codex', '--global must not overwrite workspace .atris/engine.json');

  // 6d) bench & test unknown engine + --runs 0 + --timeout 0 return exit 2 with structured JSON, no stack trace!
  for (const args of [
    ['engine', 'bench', 'bogus-engine', '--json'],
    ['engine', 'test', 'bogus-engine', '--json'],
    ['engine', 'bench', 'codex', '--runs', '0', '--json'],
    ['engine', 'bench', 'codex', '--runs', '-2', '--json'],
    ['engine', 'bench', 'codex', '--timeout', '0', '--json'],
  ]) {
    const res = runCli(args, root);
    assert.equal(res.status, 2, `${args.join(' ')} expected exit 2, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /at .*engine\.js:\d+/, 'must not dump uncaught stack trace');
    const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    assert.equal(payload.ok, false);
    assert.ok(payload.error, `expected error field for ${args.join(' ')}`);
  }
});

// =========================================================================
// Bug 7: fleet exit codes on HTTP errors & missing args, timeout, uppercase --engine.
// =========================================================================

test('Bug 7: fleet exits non-zero on HTTP 500 & usage errors, enforces HTTP timeout, and honors uppercase --engine', async (t) => {
  const dir = mkTmp(t, 'atris-bug7-fleet-');
  const home = path.join(dir, 'home');
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(ws, 'atris', 'team', 'Builder'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'atris', 'team', 'Builder', 'MEMBER.md'), '---\nname: Builder\nrole: Builder\n---\n# Builder\n');
  fs.mkdirSync(path.join(ws, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.atris', 'state', 'engines.json'), JSON.stringify({
    schema: 'atris.engine_registry.v2',
    engines: [
      { id: 'claude', health: { status: 'ready' } },
      { id: 'codex', health: { status: 'ready' } },
    ],
  }));

  let mode = 'fail';
  let stallSockets = [];
  const server = http.createServer((req, res) => {
    if (mode === 'stall' && req.url !== '/api/health' && !req.url.endsWith('/members')) {
      stallSockets.push(res);
      return; // intentionally never respond
    }
    res.writeHead(req.url === '/api/health' || (req.method === 'GET' && req.url.endsWith('/members') && mode === 'stall') ? 200 : (req.url === '/api/register' ? 201 : 500), { 'Content-Type': 'application/json' });
    if (req.url === '/api/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/api/register') return res.end(JSON.stringify({ api_key: 'k1', member_id: 'cli-test' }));
    if (mode === 'stall') return res.end(JSON.stringify({ count: 0, members: [] }));
    res.end(JSON.stringify({ error: 'server boom' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const r of stallSockets) { try { r.destroy(); } catch {} }
    server.close();
  });
  const hubUrl = `http://127.0.0.1:${server.address().port}`;
  const env = { HOME: home, USERPROFILE: home, SWARLO_SERVER: hubUrl, SWARLO_HUB: 'h7' };

  // 7a) HTTP 500 on post, task, claim, members, prune MUST exit non-zero (1)!
  for (const args of [
    ['fleet', 'post', 'hello', '--global'],
    ['fleet', 'task', 'do work', '--global'],
    ['fleet', 'claim', 'task-1', '--global'],
    ['fleet', 'members', '--global'],
    ['fleet', 'prune', '30', '--global'],
  ]) {
    const res = await runCliAsync(args, ws, env);
    assert.equal(res.status, 1, `${args.join(' ')} must exit 1 on HTTP 500, got ${res.status}`);
  }

  // 7b) Missing args for post/task/claim MUST exit non-zero (1)!
  for (const sub of ['post', 'task', 'claim']) {
    const res = await runCliAsync(['fleet', sub, '--global'], ws, env);
    assert.equal(res.status, 1, `fleet ${sub} with missing arg must exit 1, got ${res.status}`);
  }

  // 7c) Stalled HTTP server must time out instead of hanging forever!
  mode = 'stall';
  const startedAt = Date.now();
  const timeoutRes = await runCliAsync(['fleet', 'post', 'timeout-test', '--global'], ws, {
    ...env,
    ATRIS_FLEET_HTTP_TIMEOUT_MS: '200',
  });
  const elapsed = Date.now() - startedAt;
  assert.notEqual(timeoutRes.status, 0, 'stalled request must fail on timeout');
  assert.ok(elapsed < 8000, `stalled request must time out quickly, took ${elapsed}ms`);

  // 7d) Uppercase member name with --engine Builder=codex must apply codex override!
  const upRes = await runCliAsync(['fleet', 'up', 'Builder', '--engine', 'Builder=codex', '--dry-run', '--json'], ws, env);
  assert.equal(upRes.status, 0, upRes.stderr || upRes.stdout);
  const upPayload = JSON.parse(upRes.stdout.slice(upRes.stdout.indexOf('{')));
  assert.equal(upPayload.members[0].engine, 'codex', 'uppercase --engine Builder=codex must not be ignored');
});

// =========================================================================
// Bug 8 (CLI-1486): Skill eval gate cannot be bypassed via advisory_only,
// untrusted changed_files, future ts, bad rubric scores, planted worktree
// scorecards, or lib/land-green.js!
// =========================================================================

test('Bug 8: SKILL.md cannot bypass evaluation via advisory_only, changed_files, forged receipts, or land-green', (t) => {
  const dir = mkTmp(t, 'atris-bug8-skill-');
  const root = path.join(dir, 'repo');
  const skillPath = 'atris/skills/example/SKILL.md';
  fs.mkdirSync(path.join(root, path.dirname(skillPath)), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, skillPath), '# Example\n\nOriginal.\n');
  fs.writeFileSync(path.join(root, 'lib', 'plain.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok\n');
  fs.writeFileSync(path.join(root, 'check.js'), "process.exit(require('fs').readFileSync('ok.txt','utf8').trim() === 'ok' ? 0 : 1);\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0', scripts: { test: 'node check.js' } }));
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Skill Test']);
  git(root, ['config', 'user.email', 'skill@example.test']);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'seed'], { ...process.env, GIT_AUTHOR_DATE: tenDaysAgo, GIT_COMMITTER_DATE: tenDaysAgo });

  // Create isolated worktree branch that edits BOTH SKILL.md and lib/plain.js (backdated 3 days so land-green sees it as stale!)
  const branchCopy = path.join(dir, 'wt-skill');
  git(root, ['worktree', 'add', '-q', '-b', 'member/skill-change', branchCopy]);
  fs.appendFileSync(path.join(branchCopy, skillPath), '\nNew rule.\n');
  fs.appendFileSync(path.join(branchCopy, 'lib', 'plain.js'), 'module.exports = 2;\n');
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  git(branchCopy, ['add', '.']);
  git(branchCopy, ['commit', '-qm', 'edit skill and plain'], { ...process.env, GIT_AUTHOR_DATE: threeDaysAgo, GIT_COMMITTER_DATE: threeDaysAgo });

  const makeTask = (extraMeta = {}) => ({
    id: 'task-skill',
    display_id: 'CLI-1486',
    status: 'review',
    tag: 'build',
    workspace_root: root,
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: 'node --check lib/plain.js passed; git diff --check passed',
      verify: 'node --check lib/plain.js',
      worktree_path: branchCopy,
      ...extraMeta,
    },
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof: 'node --check lib/plain.js passed; git diff --check passed',
    },
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
  });

  // 8a) advisory_only=true (no changed_files declared) on isolated worktree MUST still inspect branchCopy & block!
  const advisoryBypass = evaluateAutoAccept(makeTask());
  assert.equal(advisoryBypass.eligible, false, 'advisory_only worktree task changing SKILL.md must be blocked');
  assert.equal(advisoryBypass.reason, 'skill_eval_receipt_required');

  // 8b) Untrusted metadata.changed_files omitting SKILL.md MUST NOT bypass skill eval gate!
  const narrowBypass = evaluateAutoAccept(makeTask({ changed_files: ['lib/plain.js'] }));
  assert.equal(narrowBypass.eligible, false, 'untrusted changed_files must not hide changed SKILL.md');
  assert.equal(narrowBypass.reason, 'skill_eval_receipt_required');

  // 8c) Planted scorecard inside untrusted branchCopy MUST NOT satisfy skillEvalGate!
  const validScores = { clarity: 4, trigger: 4, completeness: 4, safety: 4, verifiability: 4 };
  appendSkillEvalReceipt(branchCopy, {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date().toISOString(),
    source: 'skill_eval',
    skill_path: skillPath,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: validScores,
  });
  const planted = skillEvalGate(root, { changeRoot: branchCopy });
  assert.equal(planted.ok, false, 'receipt planted inside untrusted worktree must not pass');

  // 8d) Future timestamp & zero/negative rubric scores in trusted root MUST be rejected!
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date(Date.now() + 3600 * 1000).toISOString(),
    source: 'skill_eval',
    skill_path: skillPath,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: validScores,
  });
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date().toISOString(),
    source: 'skill_eval',
    skill_path: skillPath,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: { clarity: 0, safety: 4 },
  });
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date().toISOString(),
    source: 'skill_eval',
    skill_path: skillPath,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: { clarity: -1, safety: 4 },
  });
  assert.equal(skillEvalGate(root, { changeRoot: branchCopy }).ok, false, 'future ts and <=0 scores must be rejected');

  // 8e) lib/land-green.js MUST hold a stale branch touching SKILL.md without a valid receipt!
  git(root, ['worktree', 'remove', '--force', branchCopy]);
  const held = landStaleGreenBranches(root, { push: false, openFlags: false });
  assert.deepEqual(held.landed, [], 'land-green must NOT land unevaluated SKILL.md branch');
  const heldVerdict = held.verdicts.find((v) => v.branch === 'member/skill-change');
  assert.equal(heldVerdict.action, 'skipped');
  assert.equal(heldVerdict.reason, 'skill_eval_required');

  // Once a valid fresh passing receipt is recorded in trusted root, land-green CAN land it!
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date().toISOString(),
    source: 'skill_eval',
    skill_path: skillPath,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: validScores,
  });
  const landed = landStaleGreenBranches(root, { push: false, openFlags: false });
  assert.deepEqual(landed.landed, ['member/skill-change'], JSON.stringify(landed.verdicts));
});

// =========================================================================
// Audit Fix 1: finalizeIsolatedWorktree succeeds when .atris/ is gitignored
// AND exists on disk, never stages .atris/*, handles tracked deletions, and
// treats failed rev-parse HEAD as preserveError so work is never deleted.
// =========================================================================

test('Audit 1: isolated swarm worktree commits cleanly with gitignored .atris/ on disk, excludes .atris, and preserves on rev-parse failure', async (t) => {
  const dir = mkTmp(t, 'atris-audit1-swarm-');
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris', 'team', 'builder'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(root, 'src.txt'), 'v1\n');
  fs.writeFileSync(path.join(root, 'obsolete.txt'), 'remove-me\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Audit']);
  git(root, ['config', 'user.email', 'audit@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'seed']);

  const tasks = new Map([
    ['t-ignored-atris', { task_key: 't-ignored-atris', content: 'Edit src and write .atris/scratch.json', status: 'open', channel: 'general' }],
    ['t-revparse-fail', { task_key: 't-revparse-fail', content: 'Break HEAD after edit', status: 'done', channel: 'general' }],
  ]);
  const reports = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/health') return send(200, { status: 'ok' });
      if (req.url === '/api/register') return send(201, { member_id: parsed.member_id, api_key: `tok-${parsed.member_id}`, hub_id: parsed.hub_id });
      if (/\/posts$/.test(req.url) && req.method === 'POST') return send(201, { post_id: 'p-1' });
      if (/\/touch$/.test(req.url)) return send(200, { ok: true });
      if (/\/briefing$/.test(req.url)) return send(200, { posts: [] });
      if (/\/posts\?/.test(req.url)) return send(200, { posts: [] });
      if (/\/ready/.test(req.url)) return send(200, { tasks: [] });
      if (/\/unclaimed/.test(req.url)) {
        const open = [...tasks.values()].filter((x) => x.status === 'open');
        return send(200, { count: open.length, tasks: open });
      }
      if (/\/claim$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (!item || item.status !== 'open') return send(409, { detail: 'taken' });
        item.status = 'claimed';
        return send(201, { task_key: item.task_key, status: 'claimed' });
      }
      if (/\/report(\/once)?$/.test(req.url) && req.method === 'POST') {
        const item = tasks.get(parsed.task_key);
        if (item) item.status = parsed.status;
        reports.push(parsed);
        return send(200, { task_key: parsed.task_key, status: parsed.status });
      }
      if (/\/liveness/.test(req.url)) return send(200, { alive: [], dying: [], dead: [], orphaned_claims: [], expired_on_sweep: [] });
      if (/\/idle/.test(req.url)) return send(200, { idle: [] });
      if (/\/claims$/.test(req.url)) return send(200, { count: 0, claims: [] });
      if (/\/members$/.test(req.url)) return send(200, { count: 1, members: [] });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  assert.equal(await swarmCommand(['start', 'Audit 1', '--team', 'builder', '--server', url, '--hub', 'ha1', '--json'], { root, home, log: () => {} }), 0);

  // 1a) Worker creates .atris/scratch.json (gitignored!) + edits src.txt + adds new.txt + deletes obsolete.txt
  const execScript = [
    "const fs = require('fs');",
    "fs.mkdirSync('.atris', { recursive: true });",
    "fs.writeFileSync('.atris/scratch.json', JSON.stringify({ temp: true }));",
    "fs.writeFileSync('src.txt', 'v2\\n');",
    "fs.writeFileSync('added.txt', 'hello\\n');",
    "fs.unlinkSync('obsolete.txt');",
  ].join(' ');
  const res = await comms.runSwarmUpLoop(root, {
    durationMs: 60000,
    once: true,
    exec: `node -e ${JSON.stringify(execScript)}`,
    verify: `node -e "process.exit(require('fs').readFileSync('src.txt','utf8').trim()==='v2'?0:1)"`,
    server: url,
    hub: 'ha1',
    home,
    json: true,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const step = res.history[0].steps[0];
  assert.equal(step.ok, true, JSON.stringify(step));
  assert.ok(step.branch, 'must preserve branch when .atris/ is gitignored and exists on disk');
  assert.ok(step.commit, 'must produce commit SHA');
  assert.equal(git(root, ['show', `${step.branch}:src.txt`]), 'v2');
  assert.equal(git(root, ['show', `${step.branch}:added.txt`]), 'hello');
  const treeFiles = git(root, ['ls-tree', '-r', '--name-only', step.branch]).split('\n');
  assert.equal(treeFiles.includes('obsolete.txt'), false, 'tracked deletion must be committed');
  assert.equal(treeFiles.some((f) => f === '.atris' || f.startsWith('.atris/')), false, '.atris/scratch.json must NEVER be committed');
  assert.equal(reports.at(-1).status, 'done');

  // 1b) If git rev-parse HEAD fails during preserve (e.g. HEAD broken after commit), worktree & branch MUST be preserved (preserveError set)
  const postCommitHook = path.join(root, '.git', 'hooks', 'post-commit');
  fs.writeFileSync(postCommitHook, [
    '#!/bin/sh',
    'HEAD_FILE=$(git rev-parse --git-path HEAD)',
    'printf "ref: refs/heads/unborn-after-commit\\n" > "$HEAD_FILE"',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  tasks.get('t-revparse-fail').status = 'open';
  const resBrokenHead = await comms.runSwarmUpLoop(root, {
    durationMs: 60000,
    once: true,
    exec: `node -e "require('fs').writeFileSync('keep-me.txt', 'vital')"`,
    verify: `node -e "process.exit(require('fs').readFileSync('keep-me.txt','utf8')==='vital'?0:1)"`,
    server: url,
    hub: 'ha1',
    home,
    json: true,
  });
  assert.equal(resBrokenHead.ok, false, `failed rev-parse HEAD must fail the step: ${JSON.stringify(resBrokenHead)}`);
  assert.equal(reports.at(-1).status, 'failed');
  const wtBase = path.join(root, '.atris', 'swarm-worktrees');
  const kept = fs.existsSync(wtBase) ? fs.readdirSync(wtBase) : [];
  assert.ok(kept.some((d) => fs.existsSync(path.join(wtBase, d, 'keep-me.txt'))), 'worktree must NOT be deleted when rev-parse HEAD fails');
  const keptBranches = git(root, ['branch', '--list', 'swarm/*t-revparse-fail*']);
  assert.ok(keptBranches.trim().length > 0, 'temp branch must NOT be deleted when rev-parse HEAD fails');
});

// =========================================================================
// Audit Fix 2: Forged metadata.branch / metadata.base bypasses closed in
// lib/auto-accept-certified.js.
// =========================================================================

test('Audit 2: forged metadata.branch and self-base metadata.base cannot bypass skill eval gate', (t) => {
  const dir = mkTmp(t, 'atris-audit2-branch-bypass-');
  const root = path.join(dir, 'repo');
  const skillPath = 'atris/skills/example/SKILL.md';
  fs.mkdirSync(path.join(root, path.dirname(skillPath)), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, skillPath), '# Example\n\nOriginal.\n');
  fs.writeFileSync(path.join(root, 'lib', 'plain.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Audit']);
  git(root, ['config', 'user.email', 'audit@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'seed']);

  // Create worktree branch with TWO commits: commit 1 edits SKILL.md, commit 2 edits lib/plain.js
  const wt = path.join(dir, 'wt-forged');
  git(root, ['worktree', 'add', '-q', '-b', 'member/forged-branch', wt]);
  fs.appendFileSync(path.join(wt, skillPath), '\nHidden edit.\n');
  git(wt, ['add', '.']);
  git(wt, ['commit', '-qm', 'commit 1 skill']);
  fs.appendFileSync(path.join(wt, 'lib', 'plain.js'), 'module.exports = 2;\n');
  git(wt, ['add', '.']);
  git(wt, ['commit', '-qm', 'commit 2 plain']);

  const makeTask = (extraMeta = {}) => ({
    id: 'task-audit2',
    display_id: 'CLI-AUDIT2',
    status: 'review',
    tag: 'build',
    workspace_root: root,
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: 'node --check lib/plain.js passed; git diff --check passed',
      verify: 'node --check lib/plain.js',
      ...extraMeta,
    },
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof: 'node --check lib/plain.js passed; git diff --check passed',
    },
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
  });

  // 2a) Forged metadata.branch: 'master' on isolated worktree MUST NOT discard changeRoot skills!
  const forgedMaster = evaluateAutoAccept(makeTask({ worktree_path: wt, branch: 'master' }));
  assert.equal(forgedMaster.eligible, false, 'forged metadata.branch=master must not hide worktree SKILL.md');
  assert.equal(forgedMaster.reason, 'skill_eval_receipt_required');

  // 2b) Forged metadata.branch: 'master' with changed_files omitting SKILL.md MUST still block!
  const forgedMasterNarrow = evaluateAutoAccept(makeTask({ worktree_path: wt, branch: 'master', changed_files: ['lib/plain.js'] }));
  assert.equal(forgedMasterNarrow.eligible, false, 'forged branch=master + narrow changed_files must still block');
  assert.equal(forgedMasterNarrow.reason, 'skill_eval_receipt_required');

  // 2c) Forged self-base (metadata.base === metadata.branch) from clean root checkout MUST ignore untrusted base and block!
  const selfBase = evaluateAutoAccept(makeTask({ branch: 'member/forged-branch', base: 'member/forged-branch' }));
  assert.equal(selfBase.eligible, false, 'self-base metadata.base === metadata.branch must not bypass skill gate');
  assert.equal(selfBase.reason, 'skill_eval_receipt_required');

  // 2d) Forged parent base (metadata.base === branch~1) hiding commit 1's SKILL.md edit MUST use canonical mainline and block!
  const parentBase = evaluateAutoAccept(makeTask({ branch: 'member/forged-branch', base: 'member/forged-branch~1' }));
  assert.equal(parentBase.eligible, false, 'untrusted metadata.base=branch~1 must not hide earlier SKILL.md commit');
  assert.equal(parentBase.reason, 'skill_eval_receipt_required');

  // 2e) Uncommitted SKILL.md edit in a clean branch worktree + forged metadata.branch='master' MUST still block!
  const wtDirty = path.join(dir, 'wt-dirty-uncommitted');
  git(root, ['worktree', 'add', '-q', '-b', 'member/uncommitted-skill', wtDirty]);
  fs.appendFileSync(path.join(wtDirty, skillPath), '\nUncommitted rule.\n');
  const dirtyForged = evaluateAutoAccept(makeTask({ worktree_path: wtDirty, branch: 'master' }));
  assert.equal(dirtyForged.eligible, false, 'forged branch=master must not hide uncommitted SKILL.md edit');
  assert.equal(dirtyForged.reason, 'skill_eval_receipt_required');
});

// =========================================================================
// Audit Fix 3: All 5 lib/skill-eval-gate.js bypasses & fail-open holes closed.
// =========================================================================

test('Audit 3: skill-eval-gate catches lowercase skill.md, subfiles, git failure, backdated commits, sha256 mismatch, and learner notes consistently', (t) => {
  const dir = mkTmp(t, 'atris-audit3-skillgate-');
  const root = path.join(dir, 'repo');
  const skillPath = 'atris/skills/example/SKILL.md';
  const scriptPath = 'atris/skills/example/scripts/helper.sh';
  const refPath = 'atris/skills/example/references/guide.md';
  fs.mkdirSync(path.join(root, 'atris/skills/example/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris/skills/example/references'), { recursive: true });
  fs.writeFileSync(path.join(root, skillPath), '# Example\n');
  fs.writeFileSync(path.join(root, scriptPath), '#!/bin/sh\necho v1\n');
  fs.writeFileSync(path.join(root, refPath), '# Guide v1\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git(root, ['init', '-q', '-b', 'master']);
  git(root, ['config', 'user.name', 'Audit']);
  git(root, ['config', 'user.email', 'audit@example.test']);
  const baseDate = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'seed'], { ...process.env, GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate });

  // 3a) Lowercase skill.md MUST be detected and blocked!
  const lowerSkill = 'atris/skills/lower/skill.md';
  fs.mkdirSync(path.join(root, path.dirname(lowerSkill)), { recursive: true });
  fs.writeFileSync(path.join(root, lowerSkill), '# lower skill\n');
  const lowerGate = skillEvalGate(root);
  assert.equal(lowerGate.ok, false, 'lowercase skill.md must trigger skillEvalGate');
  assert.deepEqual(lowerGate.offenders, [lowerSkill]);
  fs.rmSync(path.join(root, 'atris/skills/lower'), { recursive: true, force: true });

  // 3b) Skill subfile edits (scripts/* and references/*) MUST map to owning SKILL.md (both worktree and branch diff)!
  const oldReceiptTs = new Date(Date.now() - 5000).toISOString();
  const scores = { clarity: 4, trigger: 4, completeness: 4, safety: 4, verifiability: 4 };
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: oldReceiptTs,
    source: 'skill_eval',
    skill_path: skillPath,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: scores,
  });
  fs.writeFileSync(path.join(root, scriptPath), '#!/bin/sh\necho v2-pwned\n');
  const subfileWorktree = skillEvalGate(root);
  assert.equal(subfileWorktree.ok, false, 'editing scripts/ inside skill dir must require fresh eval of SKILL.md');
  assert.deepEqual(subfileWorktree.offenders, [skillPath]);
  assert.equal(subfileWorktree.missing[0].reason, 'stale_receipt');

  // Committed branch diff touching ONLY references/guide.md must ALSO map to SKILL.md!
  git(root, ['checkout', '--', scriptPath]);
  git(root, ['checkout', '-qb', 'subfile-branch']);
  fs.writeFileSync(path.join(root, refPath), '# Guide v2\n');
  git(root, ['add', refPath]);
  git(root, ['commit', '-qm', 'edit reference only']);
  git(root, ['checkout', '-q', 'master']);
  const subfileBranch = skillEvalGate(root, { base: 'master', branch: 'subfile-branch' });
  assert.equal(subfileBranch.ok, false, 'branch diff editing references/ must block SKILL.md');
  assert.deepEqual(subfileBranch.offenders, [skillPath]);

  // 3c) Backdated GIT_COMMITTER_DATE commit AFTER an earlier receipt MUST be rejected as stale!
  git(root, ['checkout', '-qb', 'backdated-branch']);
  fs.appendFileSync(path.join(root, skillPath), '\nSneaky backdated change.\n');
  const backdatedIso = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
  git(root, ['add', skillPath]);
  git(root, ['commit', '-qm', 'backdated skill edit'], {
    ...process.env,
    GIT_AUTHOR_DATE: backdatedIso,
    GIT_COMMITTER_DATE: backdatedIso,
  });
  git(root, ['checkout', '-q', 'master']);
  const backdatedGate = skillEvalGate(root, { base: 'master', branch: 'backdated-branch' });
  assert.equal(backdatedGate.ok, false, 'backdated GIT_COMMITTER_DATE must NOT pass an older receipt');
  assert.equal(backdatedGate.missing[0].reason, 'stale_receipt');

  // 3d) skill_sha256 mismatch on a fresh receipt MUST be rejected!
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date(Date.now() + 2000).toISOString(),
    source: 'skill_eval',
    skill_path: skillPath,
    skill_sha256: '0'.repeat(64),
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: scores,
  });
  const badShaGate = skillEvalGate(root, { base: 'master', branch: 'backdated-branch' });
  assert.equal(badShaGate.ok, false, 'mismatched skill_sha256 must fail closed');
  assert.equal(badShaGate.missing[0].reason, 'skill_sha256_mismatch');

  // 3e) Learner-note exclusion MUST be consistent on branch ref diff (and case-insensitive)!
  git(root, ['checkout', '-qb', 'learner-branch']);
  const learnerPath = 'atris/team/navigator/skills/auto-learned/skill.md';
  fs.mkdirSync(path.join(root, path.dirname(learnerPath)), { recursive: true });
  fs.writeFileSync(path.join(root, learnerPath), '# auto learned\n');
  git(root, ['add', learnerPath]);
  git(root, ['commit', '-qm', 'learner note only']);
  git(root, ['checkout', '-q', 'master']);
  const learnerBranchGate = skillEvalGate(root, { base: 'master', branch: 'learner-branch' });
  assert.equal(learnerBranchGate.ok, true, 'learner notes must be excluded consistently on branch diffs without explicit paths');
  assert.equal(learnerBranchGate.skipped, true);

  // 3f) Epoch-zero / unknown change time (changed_at_ms === 0) MUST fail closed, never pass an old receipt!
  const epochSkill = 'atris/skills/epoch-zero/SKILL.md';
  fs.mkdirSync(path.join(root, path.dirname(epochSkill)), { recursive: true });
  fs.writeFileSync(path.join(root, epochSkill), '# epoch zero\n');
  fs.utimesSync(path.join(root, epochSkill), new Date(0), new Date(0));
  appendSkillEvalReceipt(root, {
    schema: SKILL_EVAL_SCHEMA,
    ts: oldReceiptTs,
    source: 'skill_eval',
    skill_path: epochSkill,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: scores,
  });
  const epochGate = skillEvalGate(root);
  assert.equal(epochGate.ok, false, 'changed_at_ms === 0 must fail closed instead of passing an old receipt');
  assert.equal(epochGate.missing[0].reason, 'change_time_unknown');
  fs.rmSync(path.join(root, 'atris/skills/epoch-zero'), { recursive: true, force: true });

  // 3g) Fail-closed changedSkillFiles & skillEvalGate when git repo is unreadable/corrupt!
  const broken = path.join(dir, 'broken-repo');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.git', 'HEAD'), 'corrupt\n');
  const brokenScan = changedSkillFiles(broken);
  assert.equal(brokenScan.unreadable, true, 'corrupt git repo must return unreadable: true');
  assert.deepEqual(brokenScan.skills, []);
  const brokenGate = skillEvalGate(broken);
  assert.equal(brokenGate.ok, false, 'unreadable repo must fail closed, never skipped: true');
  assert.equal(brokenGate.missing[0].reason, 'diff_unreadable');
});

// =========================================================================
// Audit Fix 4: Worktree flight collisions (no suffix false positives, preserve
// local configuredTaskSlug, team member prefix stripping) & ship HEAD merge-tree.
// =========================================================================

test('Audit 4: collidingFlights avoids suffix false positives, preserves local configuredTaskSlug, and ship resolves HEAD before merge-tree', (t) => {
  // 4a) No false-positive suffix collisions!
  const bugFixFlight = worktreeCore.parseAgentFlightName('codex/cursor-bug-fix-20260809-175253');
  const fixAuthFlight = worktreeCore.parseAgentFlightName('codex/cursor-fix-auth-20260809-175253');
  assert.equal(worktreeCore.collidingFlights([bugFixFlight], 'fix').length, 0, 'cursor-bug-fix must NOT collide with --task fix');
  assert.equal(worktreeCore.collidingFlights([fixAuthFlight], 'auth').length, 0, 'cursor-fix-auth must NOT collide with --task auth');
  assert.equal(worktreeCore.collidingFlights([bugFixFlight], 'bug-fix').length, 1);
  assert.equal(worktreeCore.collidingFlights([fixAuthFlight], 'fix-auth').length, 1);

  // 4b) Remote branch must NOT wipe local branch's configuredTaskSlug, and atris/team/* prefixes work for remote branches!
  const dir = mkTmp(t, 'atris-audit4-wt-');
  const bare = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  git(dir, ['init', '-q', '--bare', '-b', 'master', bare]);
  git(dir, ['init', '-q', '-b', 'master', repo]);
  git(repo, ['config', 'user.name', 'Audit']);
  git(repo, ['config', 'user.email', 'audit@example.test']);
  git(repo, ['remote', 'add', 'origin', bare]);
  fs.mkdirSync(path.join(repo, 'atris', 'team', 'replay-lead'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'atris', 'team', 'replay-lead', 'MEMBER.md'), '# replay-lead\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['push', '-q', '-u', 'origin', 'master']);

  const now = new Date();
  const stampText = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const localBranch = `codex/cursor-bug-fix-${stampText}`;
  git(repo, ['branch', localBranch]);
  git(repo, ['config', `branch.${localBranch}.atris-task`, 'bug-fix']);
  git(repo, ['push', '-q', 'origin', localBranch]);

  const remoteOnlyHyphenated = `codex/replay-lead-fix-auth-${stampText}`;
  git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${remoteOnlyHyphenated}`]);
  git(repo, ['fetch', '-q', 'origin']);

  const flights = worktreeCore.inFlightAgentFlights({ root: repo, now, localRemote: true });
  const localFound = flights.find((f) => f.name === localBranch);
  assert.ok(localFound, 'local branch must appear in flights');
  assert.equal(localFound.configuredTaskSlug, 'bug-fix', 'remote branch must NOT wipe local configuredTaskSlug');
  assert.equal(localFound.isLocal, true);
  assert.equal(worktreeCore.collidingFlights(flights, 'fix').length, 0, 'bug-fix must not collide with fix');
  assert.equal(worktreeCore.collidingFlights(flights, 'bug-fix').length, 1);

  assert.equal(worktreeCore.collidingFlights(flights, 'fix-auth').length, 1, 'remote hyphenated team member branch must collide on fix-auth');
  assert.equal(worktreeCore.collidingFlights(flights, 'auth').length, 0, 'remote hyphenated team member branch must NOT collide on auth');

  // 4c) worktree ship --local --merge with targetRef === 'HEAD' (detached primary + conflict on master) MUST fail merge-tree (exit 3)!
  const repo2 = path.join(dir, 'repo-head-target');
  git(dir, ['init', '-q', '-b', 'master', repo2]);
  git(repo2, ['config', 'user.name', 'Audit']);
  git(repo2, ['config', 'user.email', 'audit@example.test']);
  fs.writeFileSync(path.join(repo2, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(repo2, 'conflict.txt'), 'line 1\n');
  git(repo2, ['add', '.']);
  git(repo2, ['commit', '-qm', 'init']);

  const wtConflict = path.join(dir, 'wt-head-conflict');
  const startRes = runCli(['worktree', 'start', '--agent', 'builder', '--task', 'conflict-head', '--path', wtConflict, '--no-deps'], repo2);
  assert.equal(startRes.status, 0, startRes.stderr || startRes.stdout);

  // Advance master with a conflicting change, then detach HEAD in primary so defaultShipTarget falls back / --target HEAD is tested!
  fs.writeFileSync(path.join(repo2, 'conflict.txt'), 'master version\n');
  git(repo2, ['add', 'conflict.txt']);
  git(repo2, ['commit', '-qm', 'master conflict']);
  git(repo2, ['checkout', '-q', '--detach', 'HEAD']);

  fs.writeFileSync(path.join(wtConflict, 'conflict.txt'), 'worktree version\n');
  const shipRes = runCli([
    'worktree', 'ship', '--local', '--merge', '--target', 'HEAD',
    '--message', 'conflicting change',
    '--verify', 'git status --short',
    '--keep-copy',
  ], wtConflict);
  assert.equal(shipRes.status, 3, `merge-tree must block conflict against resolved master instead of comparing HEAD vs HEAD:\n${shipRes.stdout}\n${shipRes.stderr}`);
  assert.match(shipRes.stderr, /blocked: branch does not merge cleanly into master/);
  assert.equal(git(repo2, ['status', '--porcelain']), '', 'primary checkout must remain clean when merge-tree blocks');
});

// =========================================================================
// Audit Fix 5: commands/check.js does NOT roll back dispatch lock on SIGTERM,
// guards receipt rollback with fix_dispatched_at === at, and honors ATRIS_BIN.
// =========================================================================

test('Audit 5: check fix keeps dispatch lock on mid-dispatch SIGTERM and honors ATRIS_BIN', async (t) => {
  const dir = mkTmp(t, 'atris-audit5-checkfix-');
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, ['init', '--quiet', '--bare', '--initial-branch=master', remote]);
  git(dir, ['init', '--quiet', '--initial-branch=master', root]);
  git(root, ['config', 'user.name', 'check test']);
  git(root, ['config', 'user.email', 'check@example.test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  git(root, ['config', `url.${remote}.insteadOf`, 'https://github.com/acme/app.git']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ok.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(root, 'fail.js'), "console.log('broken'); process.exit(1);\n");
  fs.writeFileSync(path.join(root, 'src', 'f.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'atris', 'checks.json'), JSON.stringify({
    checks: { feature: { run: 'node fail.js', when: ['src/**'] }, full: { run: 'node ok.js' } },
    default: ['full'],
  }, null, 2));
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'start']);
  git(root, ['push', '--quiet', 'origin', 'master']);
  git(root, ['remote', 'set-head', 'origin', 'master']);
  git(root, ['switch', '--quiet', '-c', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'f.js'), 'module.exports = 2;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'change\n\nProof: node ok.js']);

  const saved = { ATRIS_BIN: process.env.ATRIS_BIN, ATRIS_CHECK_PERSON: process.env.ATRIS_CHECK_PERSON };
  process.env.ATRIS_CHECK_PERSON = '1';
  try {
    assert.equal(await checkCommand([], { cwd: root, log: () => {} }), 1);

    // 5a) Child launches via ATRIS_BIN and kills itself with SIGTERM (status === null, signal === 'SIGTERM', spawnError === false)
    const sigtermBin = path.join(dir, 'sigterm-atris');
    fs.writeFileSync(sigtermBin, '#!/bin/sh\necho DISPATCHED=1\nkill -TERM $$\n', { mode: 0o755 });
    process.env.ATRIS_BIN = sigtermBin;

    const sigLogs = [];
    const sigCode = await checkCommand(['fix'], { cwd: root, log: (l) => sigLogs.push(String(l)) });
    assert.equal(sigCode, 1, sigLogs.join('\n'));
    assert.match(sigLogs.join('\n'), /SIGTERM/);

    // Dispatch lock MUST remain in BOTH receipt and fix-dispatched.json!
    const receiptsDir = path.join(root, '.atris', 'receipts');
    const receiptFile = path.join(receiptsDir, fs.readdirSync(receiptsDir).find((f) => f.startsWith('check-')));
    const afterSig = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.ok(afterSig.fix_dispatched_at, 'mid-dispatch SIGTERM must NOT roll back fix_dispatched_at');
    const ledger = JSON.parse(fs.readFileSync(path.join(receiptsDir, 'fix-dispatched.json'), 'utf8'));
    assert.ok(ledger[afterSig.tree], 'mid-dispatch SIGTERM must NOT roll back fix-dispatched.json');

    // Retry MUST be refused so a second cloud job is never dispatched!
    const retryLogs = [];
    const retryCode = await checkCommand(['fix'], { cwd: root, log: (l) => retryLogs.push(String(l)) });
    assert.equal(retryCode, 2, 'retry after SIGTERM must be refused as already dispatched');
    assert.match(retryLogs.join('\n'), /one fix job per receipt/);

    // 5b) Honoring ATRIS_BIN on normal launch (clean receipt)
    delete afterSig.fix_dispatched_at;
    delete afterSig.fix_big;
    delete afterSig.fix_job;
    fs.writeFileSync(receiptFile, JSON.stringify(afterSig, null, 2));
    fs.writeFileSync(path.join(receiptsDir, 'fix-dispatched.json'), '{}\n');
    const markerFile = path.join(dir, 'atris-bin-called.txt');
    const okBin = path.join(dir, 'custom-atris');
    fs.writeFileSync(okBin, `#!/bin/sh\necho called > ${JSON.stringify(markerFile)}\necho PR_URL=https://github.com/acme/app/pull/99\n`, { mode: 0o755 });
    process.env.ATRIS_BIN = okBin;
    const okCode = await checkCommand(['fix'], { cwd: root, log: () => {} });
    assert.equal(okCode, 0);
    assert.equal(fs.existsSync(markerFile), true, 'ATRIS_BIN must be invoked');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// =========================================================================
// Audit Fix 6: commands/engine.js ask-flag no-prompt exit 2 (no silent
// mutation), test/bench --help, bench --runs --json, & fleet status --global.
// =========================================================================

test('Audit 6: engine rejects promptless ask flags without mutating default, handles test/bench --help & --runs --json, and fleet status --global exits 1 on HTTP 500', async (t) => {
  const dir = mkTmp(t, 'atris-audit6-engine-fleet-');
  const root = path.join(dir, 'ws');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USERPROFILE: home };

  // 6a) Promptless ask flags MUST exit 2 and NEVER create/mutate .atris/engine.json!
  for (const args of [
    ['engine', 'codex', '--model', 'gpt-5.6'],
    ['engine', 'codex', '--model=gpt-5.6', '--json'],
    ['engine', 'codex', '--timeout', '30', '--json'],
    ['engine', 'codex', '--concurrency', '2'],
    ['engine', 'codex', '--engines', 'claude', '--json'],
  ]) {
    const res = runCli(args, root, env);
    assert.equal(res.status, 2, `${args.join(' ')} expected exit 2, got ${res.status}: ${res.stdout} ${res.stderr}`);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'engine.json')), false, `${args.join(' ')} must NOT write .atris/engine.json`);
    if (args.includes('--json')) {
      const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
      assert.equal(payload.ok, false);
      assert.ok(payload.error);
    }
  }

  // 6b) engine test --help & engine bench --help print usage and exit 0 without running live probes
  for (const args of [['engine', 'test', '--help'], ['engine', 'bench', '--help']]) {
    const res = runCli(args, root, env);
    assert.equal(res.status, 0, `${args.join(' ')} expected exit 0: ${res.stderr}`);
    assert.match(res.stdout, new RegExp(`atris ${args[0]} ${args[1]}`));
  }

  // 6c) engine bench --runs --json & --timeout --json must NOT consume --json as value
  for (const args of [['engine', 'bench', '--runs', '--json'], ['engine', 'bench', '--timeout', '--json']]) {
    const res = runCli(args, root, env);
    assert.equal(res.status, 2, `${args.join(' ')} expected exit 2, got ${res.status}: ${res.stdout} ${res.stderr}`);
    const payload = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    assert.equal(payload.ok, false);
    assert.match(payload.error, /must be a positive integer/);
  }

  // 6d) fleet status --global (plain & --json) MUST exit 1 on HTTP 500!
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    if (req.url === '/api/register') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ api_key: 'k6', member_id: 'cli-audit6' }));
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'hub status exploded' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const fleetEnv = { ...env, SWARLO_SERVER: `http://127.0.0.1:${server.address().port}`, SWARLO_HUB: 'ha6' };

  const statusPlain = await runCliAsync(['fleet', 'status', '--global'], root, fleetEnv);
  assert.equal(statusPlain.status, 1, `fleet status --global must exit 1 on HTTP 500, got ${statusPlain.status}`);

  const statusJson = await runCliAsync(['fleet', 'status', '--global', '--json'], root, fleetEnv);
  assert.equal(statusJson.status, 1, `fleet status --global --json must exit 1 on HTTP 500, got ${statusJson.status}`);
  const statusPayload = JSON.parse(statusJson.stdout.slice(statusJson.stdout.indexOf('{')));
  assert.equal(statusPayload.ok, false);
  assert.equal(statusPayload.status, 500);
});
