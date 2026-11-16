'use strict';

// Checked work already on the main branch counts as done when its lane is
// quiet. Real git repos and a real job database; nothing faked.
//
// 2026-11-16: WEB-659, WEB-657, WEB-660, WEB-651 and WEB-635 each passed the
// builder's check and the second check and were squash merged into master,
// and still sat in review waiting for a person's accept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDb = require('../lib/task-db');
const { closeCheckedMergedJobs } = require('../lib/checked-merged-done');
const { checkedProtectedLines } = require('../lib/autoland');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-checked-merged-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atris/\natris/runs/\natris/logs/\natris/TODO.md\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  const start = git(['rev-parse', 'HEAD'], repo);
  const dbPath = path.join(base, 'tasks.db');
  process.env.ATRIS_TASKS_DB = dbPath;
  taskDb.close();
  const db = taskDb.open(dbPath);
  return { base, repo, start, db, dbPath };
}

// One squash-merged commit straight on master, the way the web repo lands.
function squashOnMaster(fx, { file, subject }) {
  fs.mkdirSync(path.dirname(path.join(fx.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, file), `// ${subject}\n`);
  git(['add', '.'], fx.repo);
  git(['commit', '-qm', subject], fx.repo);
  return git(['rev-parse', 'HEAD'], fx.repo);
}

// A commit on a side branch that never reached master.
function unmergedCommit(fx, { file, subject }) {
  git(['checkout', '-q', '-b', `side-${Date.now()}`, 'master'], fx.repo);
  const sha = squashOnMaster(fx, { file, subject });
  git(['checkout', '-q', 'master'], fx.repo);
  return sha;
}

function reviewJob(fx, { title, tag = null, metadata = {}, certified = true }) {
  const id = taskDb.addTask(fx.db, {
    title,
    tag,
    workspaceRoot: fx.repo,
    status: 'review',
    claimedBy: 'builder',
    metadata: {
      approval_status: 'pending',
      start_commit: fx.start,
      ...(certified ? {
        agent_certified: true,
        agent_review_pass_count: 2,
        agent_certification_policy: '2_agent_review_passes',
      } : { agent_review_pass_count: 1 }),
      ...metadata,
    },
  }).id;
  fx.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, id);
  return id;
}

function reviewRows(fx) {
  return taskDb.withTaskDisplayRefs(taskDb.listTasks(fx.db, { workspaceRoot: fx.repo })).filter((t) => t.status === 'review');
}

function refFor(fx, id) {
  return taskDb.withTaskDisplayRefs(taskDb.listTasks(fx.db, { workspaceRoot: fx.repo })).find((t) => t.id === id).display_id;
}

function cleanup(fx) {
  taskDb.close();
  delete process.env.ATRIS_TASKS_DB;
  fs.rmSync(fx.base, { recursive: true, force: true });
}

test('quiet, checked twice and merged: marked done as autoland, with an undo receipt', () => {
  const fx = project();
  try {
    const id = reviewJob(fx, { title: 'The Orb code loads only for people who open the Orb' });
    const ref = refFor(fx, id);
    const sha = squashOnMaster(fx, { file: 'app/dashboard/orb/OrbOnDemand.tsx', subject: `The Orb code loads only when opened (${ref}) (#1000)` });
    fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?')
      .run(`Second-actor check: \`node scripts/verify-vitest.mjs app/dashboard/orb\` exited 0. Builder proof inspected: Merged as commit ${sha.slice(0, 9)} (PR 1000).`, id);

    const out = closeCheckedMergedJobs({ root: fx.repo, tasks: reviewRows(fx), base: 'master' });
    assert.deepEqual(out.done.map((r) => r.ref), [ref], JSON.stringify(out));

    const row = taskDb.getTask(fx.db, id);
    assert.equal(row.status, 'done');
    assert.equal(row.metadata.approval_status, 'accepted');
    assert.equal(row.metadata.auto_accepted_by, 'autoland');
    assert.equal(row.metadata.auto_accept_policy, 'checked_and_merged');
    assert.equal(row.metadata.landing.status, 'landed');
    assert.equal(row.metadata.auto_done.undo, `atris task reopen ${ref} --reason "not done after all"`);
    const events = taskDb.listTaskEvents(fx.db, { taskId: id }).filter((e) => e.event_type === 'completed');
    assert.equal(events[events.length - 1].actor, 'autoland');

    const receipt = JSON.parse(fs.readFileSync(path.join(fx.repo, out.done[0].receipt), 'utf8'));
    assert.equal(receipt.ref, ref);
    assert.match(receipt.undo, /^atris task reopen /);
    assert.deepEqual(receipt.commits, [sha]);
  } finally {
    cleanup(fx);
  }
});

test('a protected lane never closes itself: sign-in by title, money by changed file', () => {
  const fx = project();
  try {
    const signIn = reviewJob(fx, { title: 'Fix the sign-in redirect after a fresh login' });
    const signInRef = refFor(fx, signIn);
    const a = squashOnMaster(fx, { file: 'app/components/Header.tsx', subject: `Redirect fix (${signInRef})` });
    const money = reviewJob(fx, { title: 'Tidy the plan card spacing' });
    const moneyRef = refFor(fx, money);
    const b = squashOnMaster(fx, { file: 'app/billing/PlanCard.tsx', subject: `Plan card spacing (${moneyRef})` });
    const release = reviewJob(fx, { title: 'Bump the version for the release', tag: 'release' });
    const releaseRef = refFor(fx, release);
    const c = squashOnMaster(fx, { file: 'lib/version.js', subject: `Version (${releaseRef})` });
    for (const [id, sha] of [[signIn, a], [money, b], [release, c]]) {
      fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?').run(`Merged as commit ${sha}`, id);
    }

    const out = closeCheckedMergedJobs({ root: fx.repo, tasks: reviewRows(fx), base: 'master' });
    assert.deepEqual(out.done, []);
    const lanes = Object.fromEntries(out.protected.map((r) => [r.ref, r.lane]));
    assert.equal(lanes[signInRef], 'security');
    assert.equal(lanes[moneyRef], 'billing');
    assert.equal(lanes[releaseRef], 'release');
    for (const id of [signIn, money, release]) assert.equal(taskDb.getTask(fx.db, id).status, 'review');
    assert.ok(out.protected.every((r) => r.merged === true));

    // One short morning list, one command for the merged ones.
    const lines = checkedProtectedLines(out.protected);
    assert.match(lines[0], /checked twice, waiting only on your yes \(3\)/);
    const tap = lines[lines.length - 1];
    assert.match(tap, /^yes to all merged: /);
    for (const ref of [signInRef, moneyRef, releaseRef]) assert.ok(tap.includes(`atris task accept ${ref}`), tap);
  } finally {
    cleanup(fx);
  }
});

test('unmerged, unchecked, or untied work stays in review', () => {
  const fx = project();
  try {
    const unmerged = reviewJob(fx, { title: 'Faster member list' });
    const unmergedRef = refFor(fx, unmerged);
    const side = unmergedCommit(fx, { file: 'app/members/List.tsx', subject: `Faster list (${unmergedRef})` });
    fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?').run(`Merged as commit ${side}`, unmerged);

    const oneCheck = reviewJob(fx, { title: 'Quieter toast', certified: false });
    const oneRef = refFor(fx, oneCheck);
    const t = squashOnMaster(fx, { file: 'app/toast/Toast.tsx', subject: `Quieter toast (${oneRef})` });
    fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?').run(`Merged as commit ${t}`, oneCheck);

    // Names a merged commit that is neither its own by message nor by files.
    const untied = reviewJob(fx, { title: 'Sharper icons', metadata: { verify: 'node scripts/verify-vitest.mjs app/icons' } });
    const other = squashOnMaster(fx, { file: 'app/unrelated/Thing.tsx', subject: 'Unrelated change' });
    fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?').run(`Merged as commit ${other}`, untied);

    // A check that failed after certification.
    const failed = reviewJob(fx, { title: 'Snappier tabs', metadata: { verify_cache: { ok: false, reason: 'verify_failed' } } });
    const failedRef = refFor(fx, failed);
    const f = squashOnMaster(fx, { file: 'app/tabs/Tabs.tsx', subject: `Snappier tabs (${failedRef})` });
    fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?').run(`Merged as commit ${f}`, failed);

    const out = closeCheckedMergedJobs({ root: fx.repo, tasks: reviewRows(fx), base: 'master' });
    assert.deepEqual(out.done, []);
    const reasons = Object.fromEntries(out.skipped.map((r) => [r.id, r.reason]));
    assert.equal(reasons[unmerged], 'not_merged');
    assert.equal(reasons[untied], 'commit_not_tied_to_job');
    for (const id of [unmerged, oneCheck, untied, failed]) assert.equal(taskDb.getTask(fx.db, id).status, 'review');
  } finally {
    cleanup(fx);
  }
});

test('the hourly tick marks quiet checked merged work done, and agents still cannot accept by hand', () => {
  const fx = project();
  try {
    fs.mkdirSync(path.join(fx.repo, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo, '.atris', 'policy', 'autoland.json'), JSON.stringify({
      enabled: true, enabled_by: 'keshav', daily_experiment: false, janitor: false, green_landing: false, map_fold: false,
    }));
    const quiet = reviewJob(fx, { title: 'Member switch is instant' });
    const quietRef = refFor(fx, quiet);
    const q = squashOnMaster(fx, { file: 'app/dashboard/Shell.tsx', subject: `Member switch is instant (${quietRef})` });
    const guarded = reviewJob(fx, { title: 'Checkout page copy', tag: 'billing' });
    const guardedRef = refFor(fx, guarded);
    const g = squashOnMaster(fx, { file: 'app/pricing/Copy.tsx', subject: `Checkout copy (${guardedRef})` });
    for (const [id, sha] of [[quiet, q], [guarded, g]]) {
      fx.db.prepare('UPDATE tasks SET metadata = json_set(metadata, \'$.latest_agent_proof\', ?) WHERE id = ?').run(`Merged as commit ${sha.slice(0, 9)}`, id);
    }
    // A job whose check this machine may not run alone: back to its builder this pass.
    const refused = reviewJob(fx, { title: 'Shell speed check', certified: false, metadata: { verify: 'node /tmp/speed/run-all.mjs --runs 5' } });
    taskDb.close();

    const env = { ...process.env, ATRIS_TASKS_DB: fx.dbPath, ATRIS_SKIP_UPDATE_CHECK: '1' };
    delete env.NODE_TEST_CONTEXT;
    delete env.ATRIS_AGENT_PROOF_ONLY;
    const res = spawnSync(process.execPath, [CLI, 'autoland', 'tick', '--json'], { cwd: fx.repo, encoding: 'utf8', env, timeout: 240000 });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const receipt = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.deepEqual(receipt.checked_merged.done.map((r) => r.ref), [quietRef], JSON.stringify(receipt.checked_merged));
    assert.ok(receipt.landed.includes(quietRef));
    assert.deepEqual(receipt.checked_merged.protected.map((r) => r.ref), [guardedRef]);
    assert.ok(Number.isFinite(receipt.step_ms.checked_merged_done));

    const db = taskDb.open(fx.dbPath);
    assert.equal(taskDb.getTask(db, quiet).status, 'done');
    assert.equal(taskDb.getTask(db, guarded).status, 'review');
    assert.deepEqual(receipt.check_reroute.sent_back.map((r) => r.id), [refused]);
    assert.equal(taskDb.getTask(db, refused).status, 'claimed');
    const state = JSON.parse(fs.readFileSync(path.join(fx.repo, '.atris', 'state', 'autoland.json'), 'utf8'));
    assert.deepEqual(state.checked_protected.rows.map((r) => r.ref), [guardedRef]);
    taskDb.close();

    // The human-only accept guard is untouched: an agent calling accept is refused.
    const agent = spawnSync(process.execPath, [CLI, 'task', 'accept', guardedRef, '--json'], {
      cwd: fx.repo, encoding: 'utf8', env: { ...env, ATRIS_AGENT_PROOF_ONLY: '1' }, timeout: 60000,
    });
    assert.notEqual(agent.status, 0, agent.stdout);
    assert.match(`${agent.stdout}${agent.stderr}`, /proof-only mode cannot accept/i);
    assert.equal(taskDb.getTask(taskDb.open(fx.dbPath), guarded).status, 'review');
  } finally {
    cleanup(fx);
  }
});
