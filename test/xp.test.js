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
      status: 'done',
    },
    action: {
      actor: overrides.actor || 'tester',
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
