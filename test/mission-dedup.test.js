const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dedup-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'master'], { cwd: repo });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
  delete env.ATRIS_RUNNER_PROFILE;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env });
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

// Born 2026-07-02: an hourly alive loop started six identical missions in one
// day. Same objective + same active owner must reuse, never clone.
test('mission start reuses an active twin instead of cloning it', () => {
  const { base, repo } = makeRepo();
  try {
    const first = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstId = JSON.parse(first.stdout).mission.id;

    const clone = runCli(['mission', 'start', 'Improve   the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(clone.status, 0, clone.stderr || clone.stdout);
    const parsed = JSON.parse(clone.stdout);
    assert.equal(parsed.action, 'mission_reused');
    assert.equal(parsed.mission.id, firstId, 'must point at the existing mission');

    const status = runCli(['mission', 'status', '--status', 'active', '--json'], repo);
    const actives = (JSON.parse(status.stdout).missions || []).filter((m) => /widget pipeline/i.test(m.objective));
    assert.equal(actives.length, 1, 'still exactly one active mission');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--duplicate forces a second mission; a different owner is not a twin', () => {
  const { base, repo } = makeRepo();
  try {
    runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);

    const otherOwner = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'validator', '--json'], repo);
    assert.equal(JSON.parse(otherOwner.stdout).action, 'mission_started', 'different owner is a different mission');

    const forced = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--duplicate', '--json'], repo);
    assert.equal(JSON.parse(forced.stdout).action, 'mission_started', '--duplicate must bypass the gate');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a stopped or completed mission is not a twin — restart is allowed', () => {
  const { base, repo } = makeRepo();
  try {
    const first = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    const id = JSON.parse(first.stdout).mission.id;
    assert.equal(runCli(['mission', 'stop', id, '--reason', 'test'], repo).status, 0);

    const again = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(JSON.parse(again.stdout).action, 'mission_started', 'stopped twin must not block a fresh start');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Retroactive cleanup: twins and stale planning rows born before the start-time
// gate existed still clutter mission status until dedupe sweeps them.
test('mission dedupe stops duplicate twins and stale planning missions', () => {
  const { base, repo } = makeRepo();
  try {
    const first = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const olderId = JSON.parse(first.stdout).mission.id;
    const forced = runCli(['mission', 'start', 'improve the widget pipeline', '--owner', 'auto-improver', '--duplicate', '--json'], repo);
    assert.equal(forced.status, 0, forced.stderr || forced.stdout);
    // Equal status: the newest twin is the keeper, the older one is clutter.
    const keeperId = JSON.parse(forced.stdout).mission.id;

    // A planning mission nobody touched for weeks, appended straight to state.
    const staleStamp = new Date(Date.now() - 30 * 86400000).toISOString();
    const staleId = 'mission-stale-planning-row';
    fs.appendFileSync(path.join(repo, '.atris', 'state', 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: staleId,
      objective: 'ancient planning mission',
      owner: 'auto-improver',
      status: 'planning',
      created_at: staleStamp,
      updated_at: staleStamp,
    }) + '\n');

    const preview = runCli(['mission', 'dedupe', '--json'], repo);
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.action, 'mission_dedupe_dry_run');
    const previewIds = previewPayload.targets.map((t) => t.id);
    assert.ok(previewIds.includes(staleId), 'stale planning row must be flagged');
    assert.equal(previewPayload.stopped.length, 0, 'dry-run must not stop anything');

    const applied = runCli(['mission', 'dedupe', '--apply', '--json'], repo);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const appliedPayload = JSON.parse(applied.stdout);
    assert.ok(appliedPayload.stopped.length >= 2, `expected twin + stale stopped, got ${JSON.stringify(appliedPayload.stopped)}`);
    assert.ok(!appliedPayload.stopped.includes(keeperId), 'the keeper twin must survive');
    assert.ok(appliedPayload.stopped.includes(olderId), 'the older twin must be stopped');

    const status = runCli(['mission', 'status', '--status', 'active', '--json'], repo);
    const active = JSON.parse(status.stdout).missions;
    assert.equal(active.length, 1, `expected one active mission, got ${active.map((m) => m.id).join(', ')}`);
    assert.equal(active[0].id, keeperId);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('mission dedupe includes duplicate missions from sibling worktrees', () => {
  const { base, repo } = makeRepo();
  try {
    runGit(['config', 'user.email', 'test@example.com'], repo);
    runGit(['config', 'user.name', 'Atris Test'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
    runGit(['add', 'README.md'], repo);
    runGit(['commit', '-q', '-m', 'init'], repo);
    const sibling = path.join(base, 'sibling');
    runGit(['worktree', 'add', '-q', '-b', 'sibling', sibling], repo);

    const keeper = runCli(['mission', 'start', 'same worktree mission', '--owner', 'auto-improver', '--json'], repo);
    assert.equal(keeper.status, 0, keeper.stderr || keeper.stdout);
    const keeperId = JSON.parse(keeper.stdout).mission.id;
    const rolled = runCli(['mission', 'start', 'same worktree mission', '--owner', 'auto-improver', '--duplicate', '--json'], sibling);
    assert.equal(rolled.status, 0, rolled.stderr || rolled.stdout);

    const preview = runCli(['mission', 'dedupe', '--json'], repo);
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.targets.length, 1);
    assert.equal(previewPayload.targets[0].rolled, true);
    assert.match(previewPayload.targets[0].root, /sibling$/);

    const applied = runCli(['mission', 'dedupe', '--apply', '--json'], repo);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const appliedPayload = JSON.parse(applied.stdout);
    assert.deepEqual(appliedPayload.stopped, [previewPayload.targets[0].id]);

    const active = JSON.parse(runCli(['mission', 'status', '--status', 'active', '--json'], repo).stdout).missions;
    assert.equal(active.length, 1);
    assert.equal(active[0].id, keeperId);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
