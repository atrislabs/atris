'use strict';

// Career XP command coverage: accrual math (buildCareerXpProjection), level
// boundaries at LEVEL_XP, the resolved workspace-root default (behavioral
// complement to the source pin in xp-workspace-root.test.js), --local --json
// smoke from a seeded temp workspace, empty-state rendering, and the shared
// flag-parser wrappers (inline --flag=value beats split --flag value).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildCareerXpProjection } = require('../commands/xp');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const LEVEL_XP = 1000;

function makeTempDir(prefix = 'atris-xp-cmd-') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function receipt(overrides = {}) {
  return {
    schema: 'atris.career_xp_receipt.v1',
    receipt_id: overrides.receipt_id || `task_review:${overrides.episode_id || 'episode-1'}`,
    source: overrides.source || 'atris-cli',
    source_type: 'task_review',
    source_task_id: overrides.task_id || 'XP-1',
    source_episode_id: overrides.episode_id || 'episode-1',
    actor: 'tester',
    outcome: overrides.outcome || 'accepted',
    xp: overrides.xp ?? 1,
    reward: overrides.xp ?? 1,
    proof: overrides.proof || 'proof accepted',
    proof_ref: overrides.proof || 'proof accepted',
    title: overrides.title || 'Proof-backed task',
    accepted_at: overrides.accepted_at || new Date().toISOString(),
  };
}

function taskEpisode(workspace, overrides = {}) {
  return {
    schema: 'atris.task_episode.v1',
    episode_id: overrides.episode_id || 'episode-1',
    task_id: overrides.task_id || 'XP-1',
    workspace_root: workspace,
    created_at: overrides.created_at || new Date().toISOString(),
    state: {
      title: overrides.title || 'Proof-backed task',
      status: overrides.status || 'done',
      claimed_by: 'codex',
    },
    action: { actor: 'tester', event_type: 'reviewed' },
    reward: { value: overrides.xp ?? 1 },
    proof: overrides.proof || 'accepted proof',
    goal: null,
    career_xp: { eligible: true, reward: overrides.xp ?? 1 },
    rl: { label: overrides.label || 'accepted' },
  };
}

function runCli(args, { cwd, env = {} }) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CODEX_THREAD_ID: '',
      CODEX_STATE_DB: path.join(os.tmpdir(), 'atris-xp-cmd-no-codex-state.sqlite'),
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('accrual: projection sums only accepted receipts with positive XP', () => {
  const workspace = makeTempDir();
  try {
    const projection = buildCareerXpProjection([
      receipt({ episode_id: 'a', xp: 3 }),
      receipt({ episode_id: 'b', xp: 7 }),
      receipt({ episode_id: 'c', xp: 5, outcome: 'rejected' }),
      receipt({ episode_id: 'd', xp: 0 }),
    ], workspace, { status: 'verified' });

    assert.equal(projection.schema, 'atris.career_xp_projection.v1');
    assert.equal(projection.total_xp, 10);
    assert.equal(projection.total_agent_xp, 10);
    assert.equal(projection.career_xp, 10);
    assert.equal(projection.receipts_count, 2);
    assert.deepEqual(projection.sources, { 'atris-cli': 2 });
    assert.equal(projection.contribution_graph.total_xp, 10);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('accrual: today_xp counts only receipts accepted on the local day', () => {
  const workspace = makeTempDir();
  try {
    const projection = buildCareerXpProjection([
      receipt({ episode_id: 'old', xp: 5, accepted_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }),
      receipt({ episode_id: 'fresh', xp: 2 }),
    ], workspace, { status: 'verified' });

    assert.equal(projection.total_xp, 7);
    assert.equal(projection.today_xp, 2);
    assert.equal(projection.today_agent_xp, 2);
    // Latest accepted proof is the most recent receipt, not the biggest one.
    assert.equal(projection.latest_accepted_proof.source_episode_id, 'fresh');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('level boundaries: 999 stays level 1, exactly 1000 crosses to level 2', () => {
  const workspace = makeTempDir();
  try {
    const atCap = buildCareerXpProjection([receipt({ xp: LEVEL_XP - 1 })], workspace, { status: 'verified' });
    assert.equal(atCap.level, 1);
    assert.equal(atCap.next_level_progress.current_xp, LEVEL_XP - 1);
    assert.equal(atCap.next_level_progress.remaining_xp, 1);
    assert.equal(atCap.next_level_progress.percent, 99.9);

    const crossed = buildCareerXpProjection([receipt({ xp: LEVEL_XP })], workspace, { status: 'verified' });
    assert.equal(crossed.level, 2);
    assert.equal(crossed.next_level_progress.current_xp, 0);
    assert.equal(crossed.next_level_progress.remaining_xp, LEVEL_XP);
    assert.equal(crossed.next_level_progress.percent, 0);

    const deep = buildCareerXpProjection([receipt({ xp: 2500 })], workspace, { status: 'verified' });
    assert.equal(deep.level, 3);
    assert.equal(deep.next_level_progress.current_xp, 500);
    assert.equal(deep.next_level_progress.next_level, 4);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('tampered integrity zeroes the projection instead of trusting receipts', () => {
  const workspace = makeTempDir();
  try {
    const projection = buildCareerXpProjection(
      [receipt({ xp: 99 })],
      workspace,
      { status: 'tampered', errors: ['receipt_hash_mismatch'] },
    );
    assert.equal(projection.total_xp, 0);
    assert.equal(projection.level, 1);
    assert.equal(projection.receipts_count, 0);
    assert.equal(projection.integrity_status, 'tampered');
    assert.equal(projection.leaderboard_eligible, false);
    assert.equal(projection.latest_accepted_proof, null);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('xp --local --json projects seeded episodes and writes the ledger triplet', () => {
  const workspace = makeTempDir();
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, { episode_id: 'smoke-1', task_id: 'SMOKE-1', xp: 4, proof: 'smoke proof one' }),
      taskEpisode(workspace, { episode_id: 'smoke-2', task_id: 'SMOKE-2', xp: 6, proof: 'smoke proof two' }),
    ]);

    const result = runCli(['xp', '--local', '--json'], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, 'atris.career_xp_projection.v1');
    assert.equal(payload.total_xp, 10);
    assert.equal(payload.level, 1);
    assert.equal(payload.receipts_count, 2);
    assert.equal(payload.integrity.status, 'verified');
    assert.equal(fs.realpathSync(payload.workspace_root), fs.realpathSync(workspace));

    const stateDir = path.join(workspace, '.atris', 'state');
    assert.ok(fs.existsSync(path.join(stateDir, 'career_xp_receipts.jsonl')));
    assert.ok(fs.existsSync(path.join(stateDir, 'career_xp.projection.json')));
    assert.ok(fs.existsSync(path.join(stateDir, 'career_xp.cursor.json')));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('rejected episodes land in the receipt chain but never in the totals', () => {
  const workspace = makeTempDir();
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, { episode_id: 'kept', task_id: 'KEEP-1', xp: 3, proof: 'kept proof' }),
      taskEpisode(workspace, { episode_id: 'bounced', task_id: 'BOUNCE-1', xp: 5, label: 'rework_requested' }),
    ]);

    const result = runCli(['xp', '--local', '--json'], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_xp, 3);
    assert.equal(payload.receipts_count, 1);

    const lines = fs.readFileSync(path.join(workspace, '.atris', 'state', 'career_xp_receipts.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    const rejected = lines.find(row => row.outcome === 'rejected');
    assert.equal(rejected.receipt_id, 'task_review:bounced:rejected');
    assert.equal(rejected.xp, 0);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('xp --local from a subdir resolves up to the workspace root by default', () => {
  const base = makeTempDir();
  try {
    const spineRoot = path.join(base, 'repo');
    const sub = path.join(spineRoot, 'backend');
    fs.mkdirSync(path.join(spineRoot, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(spineRoot, 'atris', 'atris.md'), '# spine');
    fs.mkdirSync(sub, { recursive: true });
    writeJsonl(path.join(spineRoot, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(spineRoot, { episode_id: 'root-owned', task_id: 'ROOT-1', xp: 8, proof: 'root proof' }),
    ]);

    const result = runCli(['xp', '--local', '--json'], { cwd: sub });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(fs.realpathSync(payload.workspace_root), fs.realpathSync(spineRoot));
    assert.equal(payload.total_xp, 8);
    // The projection lands beside the root episodes; no nested .atris splits off.
    assert.ok(fs.existsSync(path.join(spineRoot, '.atris', 'state', 'career_xp.projection.json')));
    assert.equal(fs.existsSync(path.join(sub, '.atris')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('empty workspace renders a level-1 zero card without inventing proof', () => {
  const workspace = makeTempDir();
  try {
    fs.mkdirSync(path.join(workspace, '.atris', 'state'), { recursive: true });

    const json = runCli(['xp', '--local', '--json'], { cwd: workspace });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.total_xp, 0);
    assert.equal(payload.today_xp, 0);
    assert.equal(payload.level, 1);
    assert.equal(payload.receipts_count, 0);
    assert.equal(payload.latest_accepted_proof, null);

    const rendered = runCli(['xp', '--local'], { cwd: workspace });
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    assert.match(rendered.stdout, /AgentXP Card/);
    assert.match(rendered.stdout, /AgentXP 0 \| Today 0 \| Career Level 1/);
    assert.match(rendered.stdout, /Latest proof: none accepted yet/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('flag wrappers: inline --workspace=path wins over the split form', () => {
  const inlineTarget = makeTempDir();
  const splitTarget = makeTempDir();
  const elsewhere = makeTempDir();
  try {
    writeJsonl(path.join(inlineTarget, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(inlineTarget, { episode_id: 'inline-win', task_id: 'FLAG-1', xp: 2, proof: 'inline proof' }),
    ]);
    fs.mkdirSync(path.join(splitTarget, '.atris', 'state'), { recursive: true });

    // Inline form alone selects the workspace (and implies local mode).
    const inlineOnly = runCli(['xp', `--workspace=${inlineTarget}`, '--json'], { cwd: elsewhere });
    assert.equal(inlineOnly.status, 0, inlineOnly.stderr || inlineOnly.stdout);
    const inlinePayload = JSON.parse(inlineOnly.stdout);
    assert.equal(fs.realpathSync(inlinePayload.workspace_root), fs.realpathSync(inlineTarget));
    assert.equal(inlinePayload.total_xp, 2);

    // With both forms present, the inline value wins regardless of order.
    const both = runCli(['xp', '--workspace', splitTarget, `--workspace=${inlineTarget}`, '--json'], { cwd: elsewhere });
    assert.equal(both.status, 0, both.stderr || both.stdout);
    const bothPayload = JSON.parse(both.stdout);
    assert.equal(fs.realpathSync(bothPayload.workspace_root), fs.realpathSync(inlineTarget));
    assert.equal(bothPayload.total_xp, 2);
  } finally {
    fs.rmSync(inlineTarget, { recursive: true, force: true });
    fs.rmSync(splitTarget, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('xp --help prints usage and exits clean', () => {
  const workspace = makeTempDir();
  try {
    const result = runCli(['xp', '--help'], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: atris xp \[card\|status\|collect\|session\|sync\]/);
    assert.match(result.stdout, /--local/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
