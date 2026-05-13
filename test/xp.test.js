const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-xp-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
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
      status: 'done',
    },
    action: {
      actor: overrides.actor || 'tester',
    },
    reward: {
      value: overrides.xp || 1,
    },
    proof: overrides.proof || 'accepted proof',
    career_xp: {
      eligible: true,
      reward: overrides.xp || 1,
    },
    rl: {
      label: 'accepted',
    },
  };
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('xp status --all aggregates verified local workspace ledgers', () => {
  const root = makeTempDir();
  try {
    const alpha = path.join(root, 'alpha');
    const beta = path.join(root, 'beta');
    writeJsonl(path.join(alpha, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(alpha, {
        episode_id: 'alpha-accepted',
        task_id: 'ALPHA-1',
        title: 'Alpha task',
        xp: 2,
        proof: 'alpha proof accepted',
        created_at: new Date(Date.now() - 1000).toISOString(),
      }),
    ]);
    writeJsonl(path.join(beta, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(beta, {
        episode_id: 'beta-accepted',
        task_id: 'BETA-1',
        title: 'Beta task',
        xp: 3,
        proof: 'beta proof accepted',
      }),
    ]);

    const result = runCli(['xp', 'status', '--all', '--root', root, '--json'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, 'atris.career_xp_profile.v1');
    assert.equal(payload.total_xp, 5);
    assert.equal(payload.today_xp, 5);
    assert.equal(payload.workspace_count, 2);
    assert.equal(payload.verified_workspace_count, 2);
    assert.equal(payload.integrity.status, 'verified');
    assert.deepEqual(payload.workspaces.map(workspace => workspace.name).sort(), ['alpha', 'beta']);
    assert.ok(payload.workspaces.every(workspace => workspace.included));
    assert.equal(payload.latest_accepted_proof.workspace_name, 'beta');
    assert.equal(payload.latest_accepted_proof.proof, 'beta proof accepted');
  } finally {
    cleanupTempDir(root);
  }
});

test('xp status --all excludes tampered local ledgers from totals', () => {
  const root = makeTempDir();
  try {
    const valid = path.join(root, 'valid');
    const tampered = path.join(root, 'tampered');
    writeJsonl(path.join(valid, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(valid, {
        episode_id: 'valid-accepted',
        task_id: 'VALID-1',
        title: 'Valid task',
        xp: 2,
        proof: 'valid proof accepted',
      }),
    ]);
    writeJsonl(path.join(tampered, '.atris', 'state', 'career_xp_receipts.jsonl'), [
      {
        schema: 'atris.career_xp_receipt.v1',
        receipt_id: 'task_review:tampered-accepted',
        source: 'atris-cli',
        source_type: 'task_review',
        source_task_id: 'BAD-1',
        source_episode_id: 'tampered-accepted',
        workspace_root: tampered,
        actor: 'tester',
        outcome: 'accepted',
        xp: 99,
        reward: 99,
        proof: 'tampered proof',
        proof_ref: 'tampered proof',
        accepted_at: new Date().toISOString(),
        chain_version: 'atris.career_xp_receipt_chain.v1',
        previous_receipt_hash: null,
        receipt_hash: 'not-the-real-hash',
      },
    ]);

    const result = runCli(['xp', 'status', '--all', '--root', root, '--json'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_xp, 2);
    assert.equal(payload.workspace_count, 2);
    assert.equal(payload.verified_workspace_count, 1);
    assert.equal(payload.integrity.status, 'warnings');
    const tamperedWorkspace = payload.workspaces.find(workspace => workspace.name === 'tampered');
    assert.equal(tamperedWorkspace.included, false);
    assert.equal(tamperedWorkspace.integrity_status, 'tampered');
    assert.match(payload.integrity.warnings[0].reason, /integrity:tampered/);
  } finally {
    cleanupTempDir(root);
  }
});
