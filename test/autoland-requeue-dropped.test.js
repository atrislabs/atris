const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun, requeueDroppedMemberRuns } = require('../lib/member-autoland');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A fake gh that appends each call's arguments to a log and serves pull
// request JSON from a config file the test can rewrite.
function writeFakeGh(bin, log, config) {
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const cfg = fs.existsSync(${JSON.stringify(config)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8')) : {};`,
    "const [a, b] = process.argv.slice(2);",
    // A commit lands in the mission folder while gh is being asked about PRs.
    "if (a === 'pr' && b === 'list' && cfg.commitOnList) require('child_process').execFileSync('sh', ['-c', 'echo late > late.txt && git add late.txt && git commit -qm late'], { cwd: cfg.commitOnList });",
    "if (a === 'pr' && b === 'list') { const cp = require('child_process'); const sha = cp.execFileSync('git', ['ls-remote', 'origin', 'refs/heads/codex/member-work'], { encoding: 'utf8' }).trim().split(/\\s+/)[0]; console.log(JSON.stringify(cfg.list || (cfg.recovery ? [{ number: 7, headRefName: 'codex/member-work', baseRefName: 'master', headRefOid: cfg.changed ? 'a'.repeat(40) : sha, isCrossRepository: false, isDraft: false, autoMergeRequest: cfg.queued ? {} : null }] : []))); }",
    "if (a === 'pr' && b === 'create') console.log(cfg.createUrl || 'https://github.com/acme/repo/pull/7');",
  ].join('\n'), { mode: 0o755 });
}

// A main checkout with a bare origin, a mission worktree on its own branch,
// and the fake gh on PATH.
function fixture({ policy, branch = 'codex/member-work', gh = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-autoland-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'atris/runs/\natris/status/\n');
  git(['add', '.'], main);
  git(['commit', '-m', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  if (policy !== undefined) {
    fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), policy);
  }
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', branch, worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'done\n');
  git(['add', '.'], worktree);
  git(['commit', '-q', '-m', 'member work'], worktree);

  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  const config = path.join(base, 'gh-config.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(config, JSON.stringify(gh));
  writeFakeGh(bin, log, config);
  const fx = { base, origin, worktree, bin, log, config, branch };
  writeRunReceipt(fx);
  return fx;
}

function passingTick(overrides = {}) {
  return {
    status: 'ran',
    tick_index: 1,
    engine_id: 'claude',
    verifier_passed: true,
    referee_result: { passed: true, mode: 'engine', engine: 'codex', output: 'VERDICT: PASS' },
    ...overrides,
  };
}

// The receipt shape a real run saves in the mission folder: every tick with
// its check and referee, whether the folder was clean, and the code tree.
function writeRunReceipt(fx, { missionId = 'mission-test', offsetMs = 0, ticks, gitTree, clean = true, kind = 'mission_run_summary' } = {}) {
  const dir = path.join(fx.worktree, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() + offsetMs).toISOString();
  const headTree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
  const runTicks = (ticks || [passingTick()]).map((tick) => (
    tick && !('reviewed_git_tree' in tick) ? { ...tick, reviewed_git_tree: headTree } : tick));
  const receipt = {
    schema: 'atris.mission_receipt.v1',
    tree_hash: 'doctrine-only',
    clean,
    git_tree: gitTree === undefined ? headTree : gitTree,
    mission_id: missionId,
    at,
    result: kind === 'mission_run_summary'
      ? { kind, tick_count: runTicks.length, ticks: runTicks }
      : { kind, tick: runTicks[0] },
  };
  fs.writeFileSync(path.join(dir, `mission-${missionId}-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify(receipt));
}

function ghCalls(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function mission(overrides = {}) {
  return {
    id: 'mission-test',
    objective: 'Tidy the member board so finished work reads plainly to the operator every morning',
    owner: 'executor',
    runner: 'claude',
    lane: 'workspace',
    metadata: {},
    task_ids: [],
    verifier_result: { passed: true, command: 'git diff --check' },
    worktree: { branch: 'codex/member-work' },
    last_tick_at: '2000-01-01T00:00:00.000Z',
    last_tick_status: 'ran',
    last_tick_index: 1,
    ...overrides,
  };
}

function withFakeGh(fx, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${fx.bin}${path.delimiter}${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

function handedOff(fx) {
  const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree });
  assert.equal(out.auto_merge, true, out.line);
  fs.writeFileSync(fx.config, JSON.stringify({ recovery: true }));
  return out;
}

function advanceBase(fx, { conflict = false } = {}) {
  const main = path.join(fx.base, 'main');
  fs.writeFileSync(path.join(main, conflict ? 'work.txt' : 'landed.txt'), 'landed elsewhere\n');
  git(['add', conflict ? 'work.txt' : 'landed.txt'], main);
  git(['commit', '-qm', 'advance main'], main);
  git(['push', '-q', 'origin', 'master'], main);
  return git(['rev-parse', 'HEAD'], main);
}

test('dropped handoff catches up to the real remote base and requeues the pinned merge', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const original = handedOff(fx).pushed;
    const base = advanceBase(fx);
    const result = requeueDroppedMemberRuns(path.join(fx.base, 'main'));
    assert.equal(result.requeued, 1, JSON.stringify(result));
    const pushed = git(['rev-parse', `refs/heads/${fx.branch}`], fx.origin);
    assert.notEqual(pushed, original);
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', pushed], fx.origin).split(' ').slice(1), [original, base]);
    assert.equal(git(['show', `${pushed}:work.txt`], fx.origin), 'done');
    assert.equal(git(['show', `${pushed}:landed.txt`], fx.origin), 'landed elsewhere');
    assert.deepEqual(ghCalls(fx).at(-1), ['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', pushed]);
    assert.equal(git(['rev-parse', 'HEAD'], fx.worktree), original);
    assert.equal(git(['status', '--porcelain'], fx.worktree), '');
    fs.writeFileSync(fx.config, JSON.stringify({ recovery: true, queued: true }));
    const calls = ghCalls(fx).filter(c => c[1] === 'merge').length;
    assert.equal(requeueDroppedMemberRuns(path.join(fx.base, 'main')).requeued, 0);
    assert.equal(ghCalls(fx).filter(c => c[1] === 'merge').length, calls);
  });
});

for (const scenario of ['changed', 'conflict', 'policy', 'refused', 'protected', 'dirty', 'closed']) {
  test(`recovery holds ${scenario} work without a new push or enqueue`, () => {
    const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
    withFakeGh(fx, () => {
      const original = handedOff(fx).pushed;
      const main = path.join(fx.base, 'main');
      let loadTask;
      if (scenario === 'changed') fs.writeFileSync(fx.config, JSON.stringify({ recovery: true, changed: true }));
      if (scenario === 'conflict') advanceBase(fx, { conflict: true });
      if (scenario === 'policy') fs.writeFileSync(path.join(main, '.atris/policy/autoland.json'), '{"enabled":false}');
      if (scenario === 'dirty') fs.writeFileSync(path.join(fx.worktree, 'work.txt'), 'unsaved\n');
      if (scenario === 'closed') fs.writeFileSync(fx.config, JSON.stringify({ list: [] }));
      if (scenario === 'refused' || scenario === 'protected') {
        const file = path.join(main, '.atris/state/member-autoland/mission-test.json');
        const saved = JSON.parse(fs.readFileSync(file));
        saved.mission.task_ids = ['task-1'];
        fs.writeFileSync(file, JSON.stringify(saved));
        loadTask = () => ({ title: 'tidy board', metadata: {}, tag: scenario === 'protected' ? 'security' : 'workspace', review: { approval_status: 'revise' } });
      }
      const calls = ghCalls(fx).filter(c => c[1] === 'merge').length;
      const result = requeueDroppedMemberRuns(main, { loadTask });
      assert.equal(result.requeued, 0);
      assert.equal(git(['rev-parse', `refs/heads/${fx.branch}`], fx.origin), original);
      assert.equal(ghCalls(fx).filter(c => c[1] === 'merge').length, calls);
      if (!['policy', 'closed'].includes(scenario)) assert.equal(result.held.length, 1);
      if (scenario === 'closed') assert.equal(requeueDroppedMemberRuns(main).scanned, 0);
    });
  });
}

test('the actual autoland CLI runs the recovery pass and writes its outcome', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true, owner: 'test', green_landing: false, janitor: false, live_updates: false, digest_hour: -1 }) });
  withFakeGh(fx, () => {
    handedOff(fx);
    advanceBase(fx);
    const command = [path.resolve(__dirname, '../bin/atris.js'), 'autoland', 'tick', '--json'];
    const run = spawnSync(process.execPath, command, {
      cwd: path.join(fx.base, 'main'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ATRIS_HOME: path.join(fx.base, 'home'), ATRIS_BACKEND_INSTALL_SIBLING: '0' },
    });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.member_requeue.requeued, 1, run.stdout);
    console.log(`real command: node bin/atris.js autoland tick --json\noutput: ${JSON.stringify(receipt.member_requeue)}\nexit: ${run.status}`);
  });
});
