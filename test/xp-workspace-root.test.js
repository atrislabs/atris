'use strict';

// Footgun (a), xp writer: the single-workspace `--workspace` default was raw
// process.cwd(), so `xp --local` from a subdir read the wrong task_episodes and
// split the career-XP projection into a nested .atris. The default must resolve
// the shared workspace root; explicit --workspace and the multi-root roster
// (discoverCareerXpWorkspaces) stay as-is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const acceptedReview = require('./fixtures/xp/accepted-review.json');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'xp.js'), 'utf8');

test('single-workspace default resolves the workspace root, not raw cwd', () => {
  // Both single-workspace sites use the resolving default...
  const resolved = SRC.match(/readInlineFirstFlag\(args, '--workspace', defaultXpWorkspace\(\)\)/g) || [];
  assert.equal(resolved.length, 2, 'both single-workspace sites use defaultXpWorkspace()');
  // ...and neither still binds the raw-cwd default.
  assert.doesNotMatch(SRC, /readInlineFirstFlag\(args, '--workspace', process\.cwd\(\)\)|readFlag\(args, '--workspace', process\.cwd\(\)\)/);
  // The multi-root search path still seeds from cwd (unchanged).
  assert.match(SRC, /roots\.push\(process\.cwd\(\)\)/);
});

test('a spine root above a subdir pulls xp state up; a standalone .atris stays put', () => {
  const { resolveWorkspaceRoot } = require('../lib/mission-root');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-xp-root-'));
  try {
    // Case 1: subdir under a framework-spine root -> resolves UP to the root.
    const spineRoot = path.join(base, 'repo');
    const sub = path.join(spineRoot, 'backend');
    fs.mkdirSync(path.join(spineRoot, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(spineRoot, 'atris', 'atris.md'), '# spine');
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(sub)), fs.realpathSync(spineRoot));

    // Case 2: a standalone workspace with its own .atris and no spine/git above
    // -> stays local (mirrors the alpha/beta fixtures in xp.test.js).
    const alone = path.join(base, 'alone');
    fs.mkdirSync(path.join(alone, '.atris', 'state'), { recursive: true });
    assert.equal(fs.realpathSync(resolveWorkspaceRoot(alone)), fs.realpathSync(alone));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('a real second-actor accept updates the main ledger automatically and survives removal of its checkout', (t) => {
  const taskDb = require('../lib/task-db');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-xp-linked-'));
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  const dbPath = path.join(base, 'tasks.db');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const env = {
    ...scrubAgentEnv(), HOME: path.join(base, 'home'), ATRIS_HOME: path.join(base, 'home', '.atris'),
    ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1',
  };
  const run = (cwd, ...args) => {
    const result = cp.spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    fs.mkdirSync(main);
    git(main, 'init', '-b', 'main');
    fs.writeFileSync(path.join(main, 'accepted.test.js'), "const assert = require('node:assert/strict');\nassert.equal(require('node:fs').readFileSync('result.txt', 'utf8'), 'accepted work');\n");
    fs.writeFileSync(path.join(main, 'result.txt'), 'accepted work');
    git(main, 'add', 'accepted.test.js', 'result.txt');
    git(main, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
    git(main, 'worktree', 'add', '-b', 'accepted-work', linked);
    const db = taskDb.open(dbPath);
    const task = taskDb.addTask(db, {
      title: acceptedReview.title, workspaceRoot: linked, status: 'review',
      claimedBy: acceptedReview.claimed_by,
      // The live job used a diff-only check, now refused by human accept.
      // Keep its second-actor history and use a real artifact check in isolation.
      metadata: {
        ...acceptedReview.metadata, verify: 'node --test accepted.test.js', latest_agent_proof: acceptedReview.proof,
      },
    });
    taskDb.close();
    const before = run(main, 'xp', '--local');
    assert.match(before, /AgentXP 0 \| Today 0/);
    const accepted = JSON.parse(run(linked, 'task', 'sweep', '--auto-accept', '--json'));
    assert.equal(accepted.summary.accepted, 1);

    // Read the file before invoking xp: accept itself must refresh the shared ledger.
    const state = path.join(main, '.atris', 'state');
    const projection = JSON.parse(fs.readFileSync(path.join(state, 'career_xp.projection.json'), 'utf8'));
    assert.equal(projection.agent_xp, acceptedReview.reward);
    assert.equal(projection.today_agent_xp, acceptedReview.reward);
    const episodes = fs.readFileSync(path.join(state, 'task_episodes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].workspace_root, linked, 'keep the original job location as attribution');
    assert.equal(episodes[0].career_xp.eligible, true);
    const after = run(main, 'xp', '--local');
    assert.match(after, /AgentXP 1 \| Today 1/);
    t.diagnostic(`real xp --local before: ${before.split('\n')[1]}`);
    t.diagnostic(`real xp --local after automatic acceptance: ${after.split('\n')[1]}`);
    assert.match(run(linked, 'xp', '--local'), /AgentXP 1 \| Today 1/);
    assert.equal(JSON.parse(run(linked, 'xp', 'status', '--local', '--workspace', linked, '--json')).agent_xp, 1);

    // Existing checkout ledgers predate the shared writer and still belong in
    // the account-wide total, without counting the shared main ledger twice.
    const legacyState = path.join(linked, '.atris', 'state');
    fs.mkdirSync(legacyState, { recursive: true });
    fs.writeFileSync(path.join(legacyState, 'task_episodes.jsonl'), `${JSON.stringify({
      ...episodes[0], episode_id: 'legacy-accepted', task_id: 'legacy-task',
      reward: { value: 2 }, career_xp: { eligible: true, reward: 2 },
    })}\n`);
    assert.equal(JSON.parse(run(main, 'xp', 'status', '--all', '--root', base, '--json')).agent_xp, 3);

    const otherDb = taskDb.open(dbPath);
    for (const status of ['open', 'claimed', 'review']) {
      const pending = taskDb.addTask(otherDb, {
        title: `unfinished ${status}`, workspaceRoot: linked, status, claimedBy: 'builder',
      });
      taskDb.reviewTask(otherDb, {
        id: pending.id, actor: 'second-reviewer', reward: 1, proof: acceptedReview.proof, careerXpEligible: true,
      });
    }
    const selfReview = taskDb.addTask(otherDb, {
      title: 'self review', workspaceRoot: linked, status: 'review', claimedBy: 'builder',
    });
    assert.equal(taskDb.reviewTask(otherDb, {
      id: selfReview.id, actor: 'builder', reward: 1, proof: acceptedReview.proof, careerXpEligible: true,
    }).reason, 'judge_equals_worker');
    for (const [title, reward, careerXpEligible, proof] of [
      ['rejected', -1, true, acceptedReview.proof],
      ['unverified', 1, false, acceptedReview.proof],
      ['missing proof', 1, true, ''],
    ]) {
      const denied = taskDb.addTask(otherDb, { title, workspaceRoot: linked, status: 'done' });
      taskDb.reviewTask(otherDb, { id: denied.id, actor: 'second-reviewer', reward, proof, careerXpEligible });
    }
    const merged = taskDb.addTask(otherDb, { title: 'merge-only close', workspaceRoot: linked });
    assert.equal(taskDb.doneTask(otherDb, { id: merged.id, actor: 'merger', autoAccepted: true }).updated, true);
    taskDb.close();
    assert.match(run(main, 'xp', '--local'), /AgentXP 1 \| Today 1/);
    git(main, 'worktree', 'remove', '--force', linked);
    assert.match(run(main, 'xp', '--local'), /AgentXP 1 \| Today 1/);
    assert.equal(JSON.parse(run(main, 'xp', 'status', '--local', '--json')).agent_xp, 1);
  } finally {
    taskDb.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('shared XP roots preserve nested workspaces and never write into separate git storage', () => {
  const { careerXpRoot } = require('../lib/career-xp-root');
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atris-xp-roots-'));
  try {
    const main = path.join(base, 'main');
    const linked = path.join(base, 'linked');
    const standalone = path.join(base, 'standalone');
    fs.mkdirSync(main);
    fs.mkdirSync(standalone);
    git(main, 'init', '-b', 'main');
    git(main, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
    git(main, 'worktree', 'add', '-b', 'work', linked);
    fs.mkdirSync(path.join(linked, 'customer'));
    assert.equal(careerXpRoot(main), main);
    assert.equal(careerXpRoot(linked), main);
    assert.equal(careerXpRoot(path.join(linked, 'customer')), path.join(main, 'customer'));
    assert.equal(careerXpRoot(standalone), standalone);
    assert.equal(careerXpRoot(path.join(base, 'missing')), path.join(base, 'missing'));
    git(standalone, 'init', `--separate-git-dir=${path.join(base, 'git-storage')}`);
    assert.equal(careerXpRoot(standalone), standalone);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
