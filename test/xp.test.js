const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { render, syncAgentXp } = require('../commands/xp');
const { saveCredentials } = require('../utils/auth');

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

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
      claimed_by: overrides.claimed_by || 'codex',
    },
    action: {
      actor: overrides.actor || 'tester',
      event_type: overrides.event_type || 'reviewed',
    },
    reward: {
      value: overrides.xp || 1,
    },
    proof: overrides.proof || 'accepted proof',
    goal: overrides.goal || null,
    career_xp: {
      eligible: true,
      reward: overrides.xp || 1,
    },
    rl: {
      label: 'accepted',
    },
  };
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      CODEX_THREAD_ID: '',
      CODEX_STATE_DB: path.join(os.tmpdir(), 'atris-xp-test-no-codex-state.sqlite'),
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function captureStdout(fn) {
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return writes.join('');
}

function runSqlite(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function seedCodexGoalState(workspace, overrides = {}) {
  const dbPath = path.join(workspace, 'codex-state.sqlite');
  const threadId = overrides.threadId || 'thread-session';
  const goalId = overrides.goalId || 'goal-session';
  const now = overrides.now || Date.now();
  const threadCwd = workspace.replace(/'/g, "''");
  runSqlite(dbPath, `
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  updated_at_ms INTEGER
);
CREATE TABLE thread_goals (
  thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO threads (id, cwd, title, updated_at_ms)
VALUES ('${threadId}', '${threadCwd}', 'session capture thread', ${now});
INSERT INTO thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms)
VALUES ('${threadId}', '${goalId}', 'Capture tonight work', 'active', NULL, 42, 17, ${now - 1000}, ${now});
`);
  return { dbPath, threadId, goalId };
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
    assert.equal(payload.metric_label, 'AgentXP');
    assert.equal(payload.agent_xp, 5);
    assert.equal(payload.total_agent_xp, 5);
    assert.equal(payload.today_agent_xp, 5);
    assert.equal(payload.total_xp, 5);
    assert.equal(payload.today_xp, 5);
    assert.equal(payload.career.card_label, 'Career Card');
    assert.equal(payload.contribution_graph.metric_label, 'AgentXP');
    assert.equal(payload.contribution_graph.total_xp, 5);
    assert.equal(payload.contribution_graph.active_days, 1);
    assert.equal(payload.workspace_count, 2);
    assert.equal(payload.verified_workspace_count, 2);
    assert.equal(payload.integrity.status, 'verified');
    assert.deepEqual(payload.workspaces.map(workspace => workspace.name).sort(), ['alpha', 'beta']);
    assert.ok(payload.workspaces.every(workspace => workspace.included));
    assert.equal(payload.latest_accepted_proof.workspace_name, 'beta');
    assert.equal(payload.latest_accepted_proof.proof, 'beta proof accepted');

    const defaultStatus = runCli(['xp', 'status', '--root', root, '--json'], { cwd: alpha });
    assert.equal(defaultStatus.status, 0, defaultStatus.stderr || defaultStatus.stdout);
    const defaultPayload = JSON.parse(defaultStatus.stdout);
    assert.equal(defaultPayload.schema, 'atris.career_xp_profile.v1');
    assert.equal(defaultPayload.agent_xp, 5);
    assert.equal(defaultPayload.total_xp, 5);

    const renderedStatus = runCli(['xp', 'status', '--root', root], { cwd: alpha });
    assert.equal(renderedStatus.status, 0, renderedStatus.stderr || renderedStatus.stdout);
    assert.match(renderedStatus.stdout, /AgentXP Card/);
    assert.match(renderedStatus.stdout, /AgentXP 5 \| Today 5 \| Career Level 1/);
    assert.match(renderedStatus.stdout, /Last 365 days: 5 AgentXP across 1 active days/);
    assert.doesNotMatch(renderedStatus.stdout, /Career XP/);

    const cardStatus = runCli(['xp', 'card', '--root', root], { cwd: alpha });
    assert.equal(cardStatus.status, 0, cardStatus.stderr || cardStatus.stdout);
    assert.match(cardStatus.stdout, /AgentXP Card/);

    const localStatus = runCli(['xp', 'status', '--local', '--json'], { cwd: alpha });
    assert.equal(localStatus.status, 0, localStatus.stderr || localStatus.stdout);
    const localPayload = JSON.parse(localStatus.stdout);
    assert.equal(localPayload.schema, 'atris.career_xp_projection.v1');
    assert.equal(localPayload.metric_label, 'AgentXP');
    assert.equal(localPayload.agent_xp, 2);
    assert.equal(localPayload.total_agent_xp, 2);
    assert.equal(localPayload.total_xp, 2);
    assert.equal(localPayload.contribution_graph.total_xp, 2);

    const localDefault = runCli(['xp', '--local', '--json'], { cwd: alpha });
    assert.equal(localDefault.status, 0, localDefault.stderr || localDefault.stdout);
    const localDefaultPayload = JSON.parse(localDefault.stdout);
    assert.equal(localDefaultPayload.schema, 'atris.career_xp_projection.v1');
    assert.equal(localDefaultPayload.total_xp, 2);

    const typo = runCli(['xp', 'stats', '--local', '--json'], { cwd: alpha });
    assert.notEqual(typo.status, 0, typo.stdout);
    assert.match(typo.stderr, /Unknown xp subcommand: stats/);
  } finally {
    cleanupTempDir(root);
  }
});

test('xp sync dry-run builds a path-private AgentXP packet', () => {
  const workspace = makeTempDir();
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'sync-accepted',
        task_id: 'SYNC-1',
        title: 'Sync accepted proof',
        xp: 7,
        proof: 'private accepted proof text',
      }),
    ]);

    const result = runCli(['xp', 'sync', '--local', '--as', 'justin', '--dry-run', '--json'], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const packetText = JSON.stringify(payload.packet);

    assert.equal(payload.schema, 'atris.agentxp_sync_preview.v1');
    assert.equal(payload.entry.username, 'justin');
    assert.equal(payload.entry.agent_xp, 7);
    assert.equal(payload.entry.verified_receipts, 1);
    assert.equal(payload.entry.leaderboard_eligible, true);
    assert.equal(payload.packet.schema, 'atris.agentxp_sync_packet.v1');
    assert.equal(payload.packet.gm_projection.schema, 'atris.gm_xp_projection.v1');
    assert.equal(payload.packet.gm_projection.workspace_root_hash, payload.packet.workspace_root_hash);
    assert.equal(payload.packet.gm_projection.operator, 'justin');
    assert.equal(payload.packet.gm_projection.player_score.agent_xp, 7);
    assert.equal(payload.packet.gm_projection.player_score.leaderboard_eligible, true);
    assert.equal(payload.packet.user_leaderboard.schema, 'atris.agentxp_user_leaderboard.v1');
    assert.equal(payload.packet.user_leaderboard.workspace_root_hash, payload.packet.workspace_root_hash);
    assert.equal(payload.packet.privacy.raw_proofs_included, false);
    assert.equal(payload.packet.privacy.raw_receipts_included, false);
    assert.equal(payload.packet.privacy.contains_absolute_workspace_root, false);
    assert.match(payload.packet.packet_hash, /^[a-f0-9]{64}$/);
    assert.equal(packetText.includes(workspace), false);
    assert.equal(packetText.includes('private accepted proof text'), false);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp sync dry-run carries local business binding for org attribution', () => {
  const workspace = makeTempDir();
  try {
    writeJson(path.join(workspace, '.atris', 'business.json'), {
      business_id: 'biz-atris',
      workspace_id: 'ws-atris',
      name: 'Atris Labs',
      slug: 'atris-labs',
      workspace_template: 'research',
      owner_email: 'private@example.com',
    });
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'sync-bound-org',
        task_id: 'SYNC-ORG',
        title: 'Sync bound org proof',
        xp: 9,
      }),
    ]);

    const result = runCli(['xp', 'sync', '--local', '--as', 'justin', '--dry-run', '--json'], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const packetText = JSON.stringify(payload.packet);
    const workspaceSummary = payload.packet.local_evidence.workspaces[0];

    assert.equal(payload.packet.attribution_scope, 'business_bound');
    assert.equal(payload.packet.business_id, 'biz-atris');
    assert.equal(payload.packet.workspace_id, 'ws-atris');
    assert.equal(payload.packet.business_slug, 'atris-labs');
    assert.equal(payload.packet.workspace_template, 'research');
    assert.equal(payload.packet.computer, 'atris-labs');
    assert.equal(payload.packet.local_evidence.business_id, 'biz-atris');
    assert.equal(payload.packet.gm_projection.business_id, 'biz-atris');
    assert.equal(workspaceSummary.business_id, 'biz-atris');
    assert.equal(workspaceSummary.workspace_id, 'ws-atris');
    assert.equal(workspaceSummary.business_slug, 'atris-labs');
    assert.equal(workspaceSummary.computer_slug, 'atris-labs');
    assert.equal(packetText.includes('private@example.com'), false);
    assert.equal(packetText.includes(workspace), false);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp sync all avoids top-level org attribution across multiple businesses', () => {
  const root = makeTempDir();
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  try {
    writeJson(path.join(alpha, '.atris', 'business.json'), {
      business_id: 'biz-alpha',
      workspace_id: 'ws-alpha',
      slug: 'alpha-lab',
      workspace_template: 'research',
    });
    writeJson(path.join(beta, '.atris', 'business.json'), {
      business_id: 'biz-beta',
      workspace_id: 'ws-beta',
      slug: 'beta-lab',
      workspace_template: 'product',
    });
    writeJsonl(path.join(alpha, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(alpha, { episode_id: 'alpha-proof', task_id: 'SYNC-A', xp: 4 }),
    ]);
    writeJsonl(path.join(beta, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(beta, { episode_id: 'beta-proof', task_id: 'SYNC-B', xp: 6 }),
    ]);

    const result = runCli(['xp', 'sync', '--all', '--root', root, '--as', 'justin', '--dry-run', '--json'], {
      cwd: root,
      env: { HOME: path.join(root, 'home') },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.packet.attribution_scope, 'multi_business');
    assert.equal(payload.packet.business_id, null);
    assert.equal(payload.packet.workspace_id, null);
    assert.equal(payload.packet.computer, 'multiple-workspaces');
    assert.equal(payload.packet.local_evidence.attribution_scope, 'multi_business');
    assert.deepEqual(
      payload.packet.local_evidence.workspaces.map(workspace => workspace.business_id).sort(),
      ['biz-alpha', 'biz-beta'],
    );
  } finally {
    cleanupTempDir(root);
  }
});

test('xp sync infers player from accepted local proof before OS user', () => {
  const workspace = makeTempDir();
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'sync-infer-proof-actor',
        task_id: 'SYNC-INFER',
        title: 'Sync inferred proof',
        xp: 3,
        actor: 'public-player',
      }),
    ]);

    const result = runCli(['xp', 'sync', '--local', '--dry-run', '--json'], {
      cwd: workspace,
      env: {
        USER: 'machine-user',
        ATRIS_PLAYER: '',
        ATRIS_USERNAME: '',
        ATRIS_PROFILE: '',
        HOME: path.join(workspace, 'home'),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.player, 'public-player');
    assert.equal(payload.entry.username, 'public-player');
    assert.equal(payload.packet.operator, 'public-player');
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp sync infers player from logged-in account profile when present', () => {
  const workspace = makeTempDir();
  const home = path.join(workspace, 'home');
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'sync-infer-account',
        task_id: 'SYNC-ACCOUNT',
        title: 'Sync account proof',
        xp: 3,
      }),
    ]);
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    writeJson(path.join(home, '.atris', 'credentials.json'), {
      token: 'local-token',
      refresh_token: 'refresh-token',
      email: 'Morgan.Agent@example.com',
      user_id: 'user-morgan',
      provider: 'test',
    });

    const result = runCli(['xp', 'sync', '--local', '--dry-run', '--json'], {
      cwd: workspace,
      env: {
        USER: 'machine-user',
        ATRIS_PLAYER: '',
        ATRIS_USERNAME: '',
        ATRIS_PROFILE: '',
        HOME: home,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.player, 'morgan-agent');
    assert.equal(payload.entry.username, 'morgan-agent');
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp local activity detects assistant surfaces without inflating receipt XP', () => {
  const workspace = makeTempDir();
  try {
    const home = path.join(workspace, 'home');
    const codexState = path.join(home, '.codex', 'state_5.sqlite');
    fs.mkdirSync(path.dirname(codexState), { recursive: true });
    fs.writeFileSync(codexState, 'sqlite placeholder', 'utf8');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.devin'), { recursive: true });
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'activity-accepted',
        task_id: 'ACT-1',
        title: 'Activity context proof',
        xp: 20,
        proof: 'activity proof accepted',
      }),
    ]);

    const env = { HOME: home, CODEX_STATE_DB: codexState };
    const result = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace, env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total_agent_xp, 20);
    assert.equal(payload.total_xp, 20);
    assert.equal(payload.earning_model.primary_public_source, 'accepted_task_receipt');
    assert.equal(payload.earning_model.weights.find(item => item.id === 'local_assistant_activity').relative_weight, 0.05);
    assert.equal(payload.local_activity.schema, 'atris.agentxp_local_assistant_activity.v1');
    assert.equal(payload.local_activity.included_in_total_agent_xp, false);
    assert.equal(payload.local_activity.public_leaderboard, false);
    assert.equal(payload.local_activity.role, 'context_only');
    assert.equal(payload.local_activity.provider_count, 4);
    assert.equal(payload.local_activity.context_weight, 0.05);
    assert.equal(payload.local_activity.cap_ratio_to_accepted_task_xp, 0.1);
    assert.equal(payload.local_activity.accepted_task_agent_xp, 20);
    assert.deepEqual(payload.local_activity.detected_providers.sort(), ['claude', 'codex', 'cursor', 'devin']);
    assert.ok(payload.local_activity.context_agent_xp > 0);
    assert.ok(payload.local_activity.context_agent_xp <= 2);

    const rendered = runCli(['xp', 'status', '--local'], { cwd: workspace, env });
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    assert.match(rendered.stdout, /Local activity: claude, codex, cursor, devin/);
    assert.match(rendered.stdout, /not public AgentXP/);

    const sync = runCli(['xp', 'sync', '--local', '--as', 'internet-test', '--dry-run', '--json'], { cwd: workspace, env });
    assert.equal(sync.status, 0, sync.stderr || sync.stdout);
    const syncPayload = JSON.parse(sync.stdout);
    assert.equal(syncPayload.entry.agent_xp, 20);
    assert.equal(syncPayload.packet.local_evidence.schema, 'atris.agentxp_local_evidence.v1');
    assert.equal(syncPayload.packet.local_evidence.workspace_root_hash, syncPayload.packet.workspace_root_hash);
    assert.equal(syncPayload.packet.local_evidence.local_activity.schema, 'atris.agentxp_local_assistant_activity.v1');
    assert.equal(syncPayload.packet.local_evidence.local_activity.included_in_total_agent_xp, false);
    assert.equal(syncPayload.packet.local_evidence.local_activity.public_leaderboard, false);
    assert.equal(syncPayload.packet.local_evidence.local_activity.role, 'context_only');
    assert.deepEqual(syncPayload.packet.local_evidence.local_activity.detected_providers.sort(), ['claude', 'codex', 'cursor', 'devin']);
    const atrisActions = syncPayload.packet.local_evidence.atris_actions;
    assert.equal(atrisActions.schema, 'atris.agentxp_atris_action_signal.v1');
    assert.equal(atrisActions.source, '.atris/state/task_episodes.jsonl');
    assert.equal(atrisActions.episode_count, 1);
    assert.equal(atrisActions.accepted_episode_count, 1);
    assert.equal(atrisActions.proof_backed_episode_count, 1);
    assert.equal(atrisActions.validation_receipt_count, 0);
    assert.equal(atrisActions.quality_receipt_count, 0);
    assert.equal(atrisActions.claimed_episode_count, 1);
    assert.equal(atrisActions.reviewed_episode_count, 1);
    assert.equal(atrisActions.distinct_actor_count, 1);
    assert.equal(atrisActions.distinct_claimant_count, 1);
    assert.deepEqual(atrisActions.event_type_counts, { reviewed: 1 });
    assert.deepEqual(atrisActions.status_counts, { done: 1 });
    assert.equal(atrisActions.included_in_total_agent_xp, false);
    assert.equal(atrisActions.public_leaderboard, false);
    assert.equal(atrisActions.role, 'rl_routing_only');
    assert.equal(JSON.stringify(syncPayload.packet).includes(workspace), false);
    assert.equal(JSON.stringify(syncPayload.packet).includes(home), false);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp sync posts the packet with the AgentXP sync token', async () => {
  const workspace = makeTempDir();
  let captured = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      captured = {
        method: req.method,
        url: req.url,
        token: req.headers['x-agentxp-sync-token'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        schema: 'atris.agentxp_sync_import.v1',
        accepted_count: 1,
        stored_count: 1,
        accepted_usernames: ['justin'],
        stored_usernames: ['justin'],
        mapped_to_authenticated_user: false,
        source: 'sync_upload',
      }));
    });
  });
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'posted-accepted',
        task_id: 'SYNC-2',
        title: 'Posted sync proof',
        xp: 4,
        proof: 'posted proof stays local',
      }),
    ]);
    const address = await listen(server);
    const previousCwd = process.cwd();
    const previousApiUrl = process.env.ATRIS_API_URL;
    const previousToken = process.env.ATRIS_AGENTXP_SYNC_TOKEN;
    process.chdir(workspace);
    process.env.ATRIS_API_URL = `http://127.0.0.1:${address.port}/api`;
    process.env.ATRIS_AGENTXP_SYNC_TOKEN = 'sync-secret';
    let payload;
    try {
      payload = await syncAgentXp(['--local', '--as', 'justin']);
    } finally {
      process.chdir(previousCwd);
      if (previousApiUrl === undefined) delete process.env.ATRIS_API_URL;
      else process.env.ATRIS_API_URL = previousApiUrl;
      if (previousToken === undefined) delete process.env.ATRIS_AGENTXP_SYNC_TOKEN;
      else process.env.ATRIS_AGENTXP_SYNC_TOKEN = previousToken;
    }

    assert.equal(payload.schema, 'atris.agentxp_sync_result.v1');
    assert.equal(payload.server.accepted_count, 1);
    assert.deepEqual(payload.server.accepted_usernames, ['justin']);
    assert.equal(payload.server.mapped_to_authenticated_user, false);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/api/agentxp/leaderboard/sync');
    assert.equal(captured.token, 'sync-secret');
    assert.equal(captured.body.operator, 'justin');
    assert.equal(captured.body.gm_projection.schema, 'atris.gm_xp_projection.v1');
    assert.equal(captured.body.gm_projection.workspace_root_hash, captured.body.workspace_root_hash);
    assert.equal(captured.body.gm_projection.player_score.agent_xp, 4);
    assert.equal(captured.body.user_leaderboard.workspace_root_hash, captured.body.workspace_root_hash);
    assert.equal(captured.body.user_leaderboard.entries[0].agent_xp, 4);
    assert.equal(JSON.stringify(captured.body).includes(workspace), false);
    assert.equal(JSON.stringify(captured.body).includes('posted proof stays local'), false);
  } finally {
    await closeServer(server).catch(() => {});
    cleanupTempDir(workspace);
  }
});

test('xp sync falls back to logged-in Atris auth when no sync token is set', async () => {
  const workspace = makeTempDir();
  const home = path.join(workspace, 'home');
  let capturedSync = null;
  let capturedValidate = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/api/auth/validate') {
        capturedValidate = {
          authorization: req.headers.authorization,
          body: JSON.parse(bodyText),
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          valid: true,
          user: { id: 'user-justin', email: 'justin@example.com', provider: 'test' },
        }));
        return;
      }
      capturedSync = {
        authorization: req.headers.authorization,
        tokenHeader: req.headers['x-agentxp-sync-token'],
        body: JSON.parse(bodyText),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        schema: 'atris.agentxp_sync_import.v1',
        accepted_count: 1,
        stored_count: 1,
        accepted_usernames: ['justin'],
        stored_usernames: ['justin'],
        mapped_to_authenticated_user: true,
        source: 'sync_upload',
      }));
    });
  });
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'auth-accepted',
        task_id: 'SYNC-3',
        title: 'Authenticated sync proof',
        xp: 6,
        proof: 'authenticated proof stays local',
      }),
    ]);
    const address = await listen(server);
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    const previousApiUrl = process.env.ATRIS_API_URL;
    const previousSyncToken = process.env.ATRIS_AGENTXP_SYNC_TOKEN;
    const previousLegacySyncToken = process.env.AGENTXP_SYNC_TOKEN;
    process.chdir(workspace);
    process.env.HOME = home;
    process.env.ATRIS_API_URL = `http://127.0.0.1:${address.port}/api`;
    delete process.env.ATRIS_AGENTXP_SYNC_TOKEN;
    delete process.env.AGENTXP_SYNC_TOKEN;
    saveCredentials('user-access-token', 'refresh-token', 'justin@example.com', 'user-justin', 'test');
    let payload;
    try {
      payload = await syncAgentXp(['--local', '--as', 'justin']);
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousApiUrl === undefined) delete process.env.ATRIS_API_URL;
      else process.env.ATRIS_API_URL = previousApiUrl;
      if (previousSyncToken === undefined) delete process.env.ATRIS_AGENTXP_SYNC_TOKEN;
      else process.env.ATRIS_AGENTXP_SYNC_TOKEN = previousSyncToken;
      if (previousLegacySyncToken === undefined) delete process.env.AGENTXP_SYNC_TOKEN;
      else process.env.AGENTXP_SYNC_TOKEN = previousLegacySyncToken;
    }

    assert.equal(payload.schema, 'atris.agentxp_sync_result.v1');
    assert.deepEqual(payload.server.accepted_usernames, ['justin']);
    assert.equal(payload.server.mapped_to_authenticated_user, true);
    assert.equal(capturedValidate.authorization, 'Bearer user-access-token');
    assert.equal(capturedValidate.body.token, 'user-access-token');
    assert.equal(capturedSync.authorization, 'Bearer user-access-token');
    assert.equal(capturedSync.tokenHeader, undefined);
    assert.equal(capturedSync.body.user_leaderboard.entries[0].agent_xp, 6);
    assert.equal(JSON.stringify(capturedSync.body).includes(workspace), false);
    assert.equal(JSON.stringify(capturedSync.body).includes('authenticated proof stays local'), false);
  } finally {
    await closeServer(server).catch(() => {});
    cleanupTempDir(workspace);
  }
});

test('xp sync without login points public players to login-first sync', async () => {
  const workspace = makeTempDir();
  const home = path.join(workspace, 'home');
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousSyncToken = process.env.ATRIS_AGENTXP_SYNC_TOKEN;
  const previousLegacySyncToken = process.env.AGENTXP_SYNC_TOKEN;
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'missing-auth-accepted',
        task_id: 'SYNC-AUTH',
        title: 'Missing auth sync proof',
        xp: 2,
      }),
    ]);
    process.chdir(workspace);
    process.env.HOME = home;
    delete process.env.ATRIS_AGENTXP_SYNC_TOKEN;
    delete process.env.AGENTXP_SYNC_TOKEN;

    await assert.rejects(
      syncAgentXp(['--local', '--as', 'public-player']),
      /Missing sync auth\. Run atris login, then retry atris xp sync\. Guided demos can pass --token <owner-provided-token>\./
    );
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSyncToken === undefined) delete process.env.ATRIS_AGENTXP_SYNC_TOKEN;
    else process.env.ATRIS_AGENTXP_SYNC_TOKEN = previousSyncToken;
    if (previousLegacySyncToken === undefined) delete process.env.AGENTXP_SYNC_TOKEN;
    else process.env.AGENTXP_SYNC_TOKEN = previousLegacySyncToken;
    cleanupTempDir(workspace);
  }
});

test('xp sync dry-run render points players to login-first publish', () => {
  const output = captureStdout(() => render({
    schema: 'atris.agentxp_sync_preview.v1',
    dry_run: true,
    player: 'public-player',
    entry: {
      username: 'public-player',
      agent_xp: 1,
      verified_receipts: 1,
    },
    packet: {
      packet_hash: 'packet123',
    },
  }));

  assert.match(output, /Run atris login, then atris xp sync --local to publish/);
  assert.match(output, /Guided demos can pass --token <owner-provided-token>\./);
});

test('xp sync render shows server public identity mapping', () => {
  const output = captureStdout(() => render({
    schema: 'atris.agentxp_sync_result.v1',
    dry_run: false,
    player: 'sync-identity-smoke',
    entry: {
      username: 'sync-identity-smoke',
      agent_xp: 1,
      verified_receipts: 1,
    },
    packet_hash: 'abc123',
    server: {
      accepted_count: 1,
      stored_count: 1,
      accepted_usernames: ['keshav'],
      stored_usernames: ['keshav'],
      mapped_to_authenticated_user: true,
      source: 'sync_upload',
    },
  }));

  assert.match(output, /Public identity: keshav/);
  assert.match(output, /Login auth mapped this sync to your Atris account\./);
  assert.match(output, /Leaderboard: https:\/\/api\.atris\.ai\/api\/agentxp\/leaderboard/);
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

test('xp status fails closed when receipt chain metadata is tampered', () => {
  const workspace = makeTempDir();
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'meta-accepted-1',
        task_id: 'META-1',
        title: 'Metadata receipt one',
        proof: 'metadata proof one',
      }),
      taskEpisode(workspace, {
        episode_id: 'meta-accepted-2',
        task_id: 'META-2',
        title: 'Metadata receipt two',
        proof: 'metadata proof two',
      }),
    ]);

    const firstStatus = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace });
    assert.equal(firstStatus.status, 0, firstStatus.stderr || firstStatus.stdout);
    assert.equal(JSON.parse(firstStatus.stdout).total_xp, 2);

    const receiptsPath = path.join(workspace, '.atris', 'state', 'career_xp_receipts.jsonl');
    const receipts = fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(receipts.length, 2);
    receipts[0].chain_version = 'atris.career_xp_receipt_chain.v0';
    receipts[1].previous_receipt_hash = 'not-the-previous-receipt';
    writeJsonl(receiptsPath, receipts);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.integrity.status, 'tampered');
    assert.equal(payload.total_xp, 0);
    assert.match(payload.integrity.errors.join('\n'), /receipt_chain_version_mismatch/);
    assert.match(payload.integrity.errors.join('\n'), /receipt_previous_hash_mismatch/);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp session writes a local capsule for the current proof-backed work window', () => {
  const workspace = makeTempDir();
  try {
    const now = Date.now();
    const old = now - 36 * 60 * 60 * 1000;
    const acceptedTaskId = 'task-accepted';
    const reviewTaskId = 'task-review';
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'old-accepted',
        task_id: 'task-old',
        title: 'Old accepted task',
        xp: 9,
        proof: 'old proof accepted',
        created_at: new Date(old).toISOString(),
      }),
      taskEpisode(workspace, {
        episode_id: 'session-accepted',
        task_id: acceptedTaskId,
        title: 'Ship session capsule',
        xp: 2,
        proof: 'session proof accepted',
        created_at: new Date(now).toISOString(),
        goal: {
          id: 'goal-session-capture',
          objective: 'Capture tonight work',
          status: 'active',
        },
      }),
    ]);
    writeJson(path.join(workspace, '.atris', 'state', 'tasks.projection.json'), {
      schema: 'atris.tasks_projection.v1',
      tasks: [
        {
          id: acceptedTaskId,
          display_id: 'XP-10',
          title: 'Ship session capsule',
          status: 'done',
          tag: 'career-xp',
          claimed_by: 'codex',
          created_at: now - 1000,
          updated_at: now,
          done_at: now,
          review: {
            approval_status: 'accepted',
            proof: 'session proof accepted',
            summary: 'The work session now has a capsule.',
          },
        },
        {
          id: reviewTaskId,
          display_id: 'XP-11',
          title: 'Review pending proof',
          status: 'review',
          tag: 'career-xp',
          claimed_by: 'codex',
          created_at: now - 500,
          updated_at: now,
          review: {
            approval_status: 'pending',
            proof: 'pending proof',
            summary: 'Waiting for human judgment.',
          },
        },
        {
          id: 'task-old',
          display_id: 'XP-1',
          title: 'Old accepted task',
          status: 'done',
          tag: 'career-xp',
          created_at: old,
          updated_at: old,
          done_at: old,
        },
      ],
    });

    const codexState = seedCodexGoalState(workspace, { now });
    const result = runCli([
      'xp',
      'session',
      '--workspace',
      workspace,
      '--since',
      'today',
      '--codex-state',
      codexState.dbPath,
      '--thread',
      codexState.threadId,
      '--json',
    ], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, 'atris.career_xp_session_capsule.v1');
    assert.equal(payload.workspace_root, workspace);
    assert.equal(payload.xp.delta_agent_xp, 2);
    assert.equal(payload.xp.before_agent_xp, 9);
    assert.equal(payload.xp.after_agent_xp, 11);
    assert.equal(payload.xp.delta_xp, 2);
    assert.equal(payload.xp.before_total_xp, 9);
    assert.equal(payload.xp.after_total_xp, 11);
    assert.equal(payload.xp.integrity_status, 'verified');
    assert.equal(payload.tasks.touched_count, 2);
    assert.equal(payload.tasks.review_count, 1);
    assert.equal(payload.tasks.accepted_count, 1);
    assert.equal(payload.proof.receipts_count, 1);
    assert.equal(payload.proof.latest_accepted.proof, 'session proof accepted');
    assert.equal(payload.goals.touched[0].label, 'Capture tonight work');
    assert.equal(payload.goals.touched[0].provider, 'codex');
    assert.equal(payload.goals.touched[0].tokens_used, 42);
    assert.equal(payload.goals.touched[0].time_used_seconds, 17);
    assert.match(payload.next_quest, /Review XP-11/);
    assert.ok(fs.existsSync(payload.files.session_path));
    const written = JSON.parse(fs.readFileSync(payload.files.session_path, 'utf8'));
    assert.equal(written.schema, 'atris.career_xp_session_capsule.v1');
    assert.equal(written.xp.delta_xp, 2);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp session --no-write previews receipts without mutating the local ledger', () => {
  const workspace = makeTempDir();
  try {
    const episodePath = path.join(workspace, '.atris', 'state', 'task_episodes.jsonl');
    writeJsonl(episodePath, [
      taskEpisode(workspace, {
        episode_id: 'no-write-preview',
        task_id: 'task-no-write-preview',
        title: 'Preview XP without writes',
        xp: 1,
        proof: 'preview proof accepted',
      }),
    ]);

    const result = runCli(['xp', 'session', '--workspace', workspace, '--since', 'today', '--no-write', '--json'], { cwd: workspace });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.written, false);
    assert.equal(payload.xp.delta_xp, 1);
    assert.equal(payload.xp.after_total_xp, 1);
    assert.equal(payload.proof.receipts_count, 1);
    assert.equal(payload.files.session_path, null);

    assert.equal(fs.existsSync(path.join(workspace, '.atris', 'state', 'career_xp_receipts.jsonl')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.atris', 'state', 'career_xp.cursor.json')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.atris', 'state', 'career_xp.projection.json')), false);
    assert.equal(fs.existsSync(path.join(workspace, '.atris', 'state', 'career_xp_sessions')), false);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp session skips a partial trailing task episode without advancing the cursor', () => {
  const workspace = makeTempDir();
  try {
    const now = new Date().toISOString();
    const episodePath = path.join(workspace, '.atris', 'state', 'task_episodes.jsonl');
    const validEpisode = taskEpisode(workspace, {
      episode_id: 'partial-safe',
      task_id: 'task-partial-safe',
      title: 'Keep local XP capture durable',
      xp: 2,
      proof: 'valid proof before a partial write',
      created_at: now,
      goal: {
        id: 'goal-partial-safe',
        objective: 'Keep local XP capture durable',
        status: 'active',
      },
    });
    fs.mkdirSync(path.dirname(episodePath), { recursive: true });
    fs.writeFileSync(
      episodePath,
      `${JSON.stringify(validEpisode)}\n{"schema":"atris.task_episode.v1","episode_id":`,
      'utf8'
    );

    const result = runCli([
      'xp',
      'session',
      '--workspace',
      workspace,
      '--since',
      'today',
      '--json',
    ], { cwd: workspace });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.xp.delta_xp, 2);
    assert.equal(payload.proof.receipts_count, 1);
    assert.ok(payload.warnings.includes('task_episodes_partial_tail_waiting'));
    assert.equal(payload.goals.touched[0].label, 'Keep local XP capture durable');

    const cursor = JSON.parse(fs.readFileSync(path.join(workspace, '.atris', 'state', 'career_xp.cursor.json'), 'utf8'));
    assert.equal(cursor.last_episode_id, 'partial-safe');
    assert.equal(cursor.skipped_partial_tail, true);
    assert.ok(cursor.bytes_read < cursor.source_size);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp status cursor stays byte-aligned after newline-terminated JSONL append', () => {
  const workspace = makeTempDir();
  try {
    const episodePath = path.join(workspace, '.atris', 'state', 'task_episodes.jsonl');
    writeJsonl(episodePath, [
      taskEpisode(workspace, {
        episode_id: 'cursor-first',
        task_id: 'task-cursor-first',
        title: 'First cursor-safe proof',
        xp: 1,
        proof: 'first proof accepted',
      }),
    ]);

    const first = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.collected_receipts, 1);
    assert.equal(firstPayload.integrity.cursor.bytes_read, fs.statSync(episodePath).size);

    const cursorPath = path.join(workspace, '.atris', 'state', 'career_xp.cursor.json');
    const staleCursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    staleCursor.bytes_read = fs.statSync(episodePath).size + 1;
    staleCursor.source_size = fs.statSync(episodePath).size;
    writeJson(cursorPath, staleCursor);

    fs.appendFileSync(
      episodePath,
      `${JSON.stringify(taskEpisode(workspace, {
        episode_id: 'cursor-second',
        task_id: 'task-cursor-second',
        title: 'Second cursor-safe proof',
        xp: 1,
        proof: 'second proof accepted',
      }))}\n`,
      'utf8'
    );

    const second = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.collected_receipts, 1);
    assert.equal(secondPayload.total_xp, 2);
    assert.equal(secondPayload.latest_accepted_proof.proof, 'second proof accepted');
    assert.equal(secondPayload.integrity.cursor.bytes_read, fs.statSync(episodePath).size);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp status replays accepted episodes when the receipt ledger is missing', () => {
  const workspace = makeTempDir();
  try {
    const episodePath = path.join(workspace, '.atris', 'state', 'task_episodes.jsonl');
    writeJsonl(episodePath, [
      taskEpisode(workspace, {
        episode_id: 'replay-accepted',
        task_id: 'task-replay-accepted',
        title: 'Replay accepted proof',
        xp: 2,
        proof: 'accepted proof should replay',
      }),
    ]);

    const first = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstPayload = JSON.parse(first.stdout);
    assert.equal(firstPayload.total_xp, 2);
    assert.equal(firstPayload.collected_receipts, 1);

    const receiptsPath = path.join(workspace, '.atris', 'state', 'career_xp_receipts.jsonl');
    const projectionPath = path.join(workspace, '.atris', 'state', 'career_xp.projection.json');
    fs.rmSync(receiptsPath, { force: true });
    fs.rmSync(projectionPath, { force: true });

    const second = runCli(['xp', 'status', '--local', '--json'], { cwd: workspace });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.total_xp, 2);
    assert.equal(secondPayload.collected_receipts, 1);
    assert.equal(secondPayload.integrity.cursor.reset, true);
    assert.equal(secondPayload.latest_accepted_proof.proof, 'accepted proof should replay');
    assert.equal(fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally {
    cleanupTempDir(workspace);
  }
});

test('xp session reports an unreadable task projection without blocking verified XP', () => {
  const workspace = makeTempDir();
  try {
    writeJsonl(path.join(workspace, '.atris', 'state', 'task_episodes.jsonl'), [
      taskEpisode(workspace, {
        episode_id: 'projection-safe',
        task_id: 'task-projection-safe',
        title: 'Capture XP with a bad task projection',
        xp: 1,
        proof: 'verified proof survives bad projection',
        created_at: new Date().toISOString(),
      }),
    ]);
    const projectionPath = path.join(workspace, '.atris', 'state', 'tasks.projection.json');
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(projectionPath, '{"schema":"atris.tasks_projection.v1","tasks":[', 'utf8');

    const result = runCli([
      'xp',
      'session',
      '--workspace',
      workspace,
      '--since',
      'today',
      '--json',
    ], { cwd: workspace });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.xp.delta_xp, 1);
    assert.equal(payload.proof.receipts_count, 1);
    assert.equal(payload.tasks.touched_count, 0);
    assert.ok(payload.warnings.some(warning => warning.startsWith('task_projection_unreadable:')));
  } finally {
    cleanupTempDir(workspace);
  }
});
