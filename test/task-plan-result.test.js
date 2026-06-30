const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch (_) {
    return false;
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-plan-result-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    encoding: 'utf8',
  });
}

function runCliAsync(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        NODE_NO_WARNINGS: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function writeMember(root, slug, { role, description }) {
  const dir = path.join(root, 'atris', 'team', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${slug}`,
    `role: ${role}`,
    `description: ${description}`,
    '---',
    '',
    `# ${role}`,
    '',
  ].join('\n'), 'utf8');
}

test('task plan-preview picks a specific team member and prints plain Plan text', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writeMember(dir, 'signup-owner', {
      role: 'Signup Owner',
      description: 'Knows the signup files and checks.',
    });
    writeMember(dir, 'executor', {
      role: 'Executor',
      description: 'Does general tasks.',
    });
    writeMember(dir, 'signup-owner', {
      role: 'Signup Owner',
      description: 'Knows the signup files and checks.',
    });

    const res = runCli([
      'task',
      'plan-preview',
      'Fix signup button',
      '--tag',
      'signup',
      '--plan',
      'signup-owner will inspect the signup button, make the smallest fix, then open the page and click it.',
      '--expected',
      'signup opens the account screen and the check passes.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.action, 'plan_preview');
    assert.equal(body.plan.owner, 'signup-owner');
    assert.equal(body.owner_choice.source, 'team');
    assert.match(body.text, /Purpose: Fix signup button/);
    assert.match(body.text, /Owner: signup-owner is handling it\./);
    assert.match(body.text, /Why: signup-owner fits this work because knows the signup files and checks\./);
    assert.match(body.text, /Plan: signup-owner will inspect the signup button/);
    assert.match(body.text, /Expected result: signup opens the account screen and the check passes\./);
    assert.doesNotMatch(body.text, /takeoff|landing|router|verifier|harness|model|atris\/team/i);

    const text = runCli([
      'task',
      'plan-preview',
      'Fix signup button',
      '--tag',
      'signup',
      '--plan',
      'signup-owner will inspect the signup button, make the smallest fix, then open the page and click it.',
      '--expected',
      'signup opens the account screen and the check passes.',
    ], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Purpose: Fix signup button/);
    assert.doesNotMatch(text.stdout, /takeoff|landing|router|verifier|harness|model|atris\/team/i);

    const add = runCli(['task', 'add', 'Fix signup button', '--tag', 'signup', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const taskRef = JSON.parse(add.stdout).task.display_id;

    const recorded = runCli([
      'task',
      'plan-preview',
      'Fix signup button',
      '--tag',
      'signup',
      '--plan',
      'signup-owner will inspect the signup button, make the smallest fix, then open the page and click it.',
      '--expected',
      'signup opens the account screen and the check passes.',
      '--task',
      taskRef,
      '--json',
    ], { cwd: dir, env });
    assert.equal(recorded.status, 0, recorded.stderr);
    const recordedBody = JSON.parse(recorded.stdout);
    assert.equal(recordedBody.recorded.version, 2);

    const show = runCli(['task', 'show', taskRef, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    const trace = task.messages.find(message => message.content.startsWith('TASK_PLAN_TRACE '));
    assert.ok(trace, 'plan-preview --task should store a plan trace');
    assert.match(trace.content, /"owner":"signup-owner"/);
    assert.match(trace.content, /"expected_result":"signup opens the account screen and the check passes\."/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task plan and ready automatically save Plan and Result traces', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writeMember(dir, 'signup-owner', {
      role: 'Signup Owner',
      description: 'Knows the signup files and checks.',
    });

    const add = runCli(['task', 'add', 'Fix signup button', '--tag', 'signup', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const plan = runCli([
      'task',
      'plan',
      ref,
      '--as',
      'codex',
      '--goal',
      'Fix signup button',
      '--summary',
      'Inspect the signup button, make the smallest fix, then check it.',
      '--exit',
      'signup opens the account screen',
      '--proof-needed',
      'open the page and click signup',
      '--first-move',
      'inspect the signup button',
      '--json',
    ], { cwd: dir, env });
    assert.equal(plan.status, 0, plan.stderr);
    const planned = JSON.parse(plan.stdout);
    assert.equal(planned.plan_trace.trace.owner, 'signup-owner');
    assert.match(planned.stage_packet, /TASK_PLAN_TRACE /);
    assert.match(planned.stage_packet, /"owner":"signup-owner"/);

    const showPlanned = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(showPlanned.status, 0, showPlanned.stderr);
    const plannedTask = JSON.parse(showPlanned.stdout);
    assert.equal(plannedTask.history.message_count, 1);
    assert.equal(plannedTask.messages.filter(message => message.content.includes('TASK_PLAN_TRACE ')).length, 1);

    const ready = runCli([
      'task',
      'ready',
      ref,
      '--as',
      'signup-owner',
      '--proof',
      'node --test test/task-plan-result.test.js passed for signup result trace',
      '--changed',
      'fixed the signup button',
      '--checked',
      'opened the page and clicked signup',
      '--saved',
      'task trace, signup-owner log, and review record were updated so the human can see exactly what changed',
      '--try',
      'click signup and confirm the account screen opens',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyBody = JSON.parse(ready.stdout);
    assert.equal(readyBody.action, 'ready');
    assert.equal(readyBody.result_trace.result.owner, 'signup-owner');
    assert.equal(readyBody.result_trace.result.saved, 'task trace, signup-owner log, and review record were updated so the human can see exactly what changed');
    assert.equal(readyBody.result_trace.result.try_next, 'click signup and confirm the account screen opens');
    assert.match(readyBody.result_trace.saved_paths.member_log_path, /^atris\/team\/signup-owner\/logs\/\d{4}-\d{2}-\d{2}\.md$/);

    const events = runCli(['task', 'events', ref, '--json'], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    const readyEvent = JSON.parse(events.stdout).events.find(event => event.event_type === 'proof_ready');
    assert.ok(readyEvent.payload.result_trace, 'ready should store a Result trace on the review event');
    assert.equal(readyEvent.payload.result_trace.saved, 'task trace, signup-owner log, and review record were updated so the human can see exactly what changed');
    assert.equal(readyEvent.payload.result_trace.try_next, 'click signup and confirm the account screen opens');
    assert.match(readyEvent.payload.result_packet, /TASK_RESULT_TRACE /);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task result prints plain Result text and stores a trace on the task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writeMember(dir, 'signup-owner', {
      role: 'Signup Owner',
      description: 'Knows the signup files and checks.',
    });

    const add = runCli(['task', 'add', 'Internal takeoff landing wording', '--tag', 'signup', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const plan = runCli([
      'task',
      'plan-preview',
      'Fix signup button',
      '--tag',
      'signup',
      '--owner',
      'signup-owner',
      '--plan',
      'signup-owner will inspect the signup button, make the smallest fix, then open the page and click it.',
      '--expected',
      'signup opens the account screen and the check passes.',
      '--task',
      ref,
      '--json',
    ], { cwd: dir, env });
    assert.equal(plan.status, 0, plan.stderr);

    const missingTry = runCli([
      'task',
      'result',
      ref,
      '--changed',
      'fixed the signup button bug',
      '--checked',
      'opened the page and clicked signup',
      '--saved',
      'task note and team log were updated',
    ], { cwd: dir, env });
    assert.equal(missingTry.status, 2);
    assert.match(missingTry.stderr, /--try required/);

    const result = runCli([
      'task',
      'result',
      ref,
      '--as',
      'signup-owner',
      '--changed',
      'fixed the signup button bug',
      '--checked',
      'opened the page, clicked signup, and saw the account screen',
      '--passed',
      'signup check passed',
      '--cost',
      '$0.03',
      '--saved',
      'task note, team log, and feature note were updated',
      '--try',
      'click signup and confirm the account screen opens',
      '--status',
      'ready for you to try',
      '--files',
      'app/signup.js',
      '--commands',
      'npm test -- signup',
      '--json',
    ], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.action, 'result');
    assert.ok(body.saved_paths.member_log_path);
    assert.match(body.saved_paths.member_log_path, /^atris\/team\/signup-owner\/logs\/\d{4}-\d{2}-\d{2}\.md$/);
    assert.deepEqual(body.text.split('\n'), [
      'Changed: fixed the signup button bug',
      'Checked: opened the page, clicked signup, and saw the account screen',
      'Try: click signup and confirm the account screen opens',
    ]);
    assert.doesNotMatch(body.text, /takeoff|landing/i);
    assert.doesNotMatch(body.text, /Purpose:|Owner:|Passed:|Cost:|Saved:|Status:|takeoff|landing|router|verifier|harness|model/i);

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    const trace = task.messages.find(message => message.content.startsWith('TASK_RESULT_TRACE '));
    assert.ok(trace, 'result command should store a trace note');
    assert.match(trace.content, /"files":"app\/signup\.js"/);
    assert.match(trace.content, /"commands":"npm test -- signup"/);
    assert.match(trace.content, /"owner":"signup-owner"/);
    assert.match(trace.content, /"saved":"task note, team log, and feature note were updated"/);
    assert.match(trace.content, /"try_next":"click signup and confirm the account screen opens"/);
    assert.match(trace.content, /"member_log_path":"atris\/team\/signup-owner\/logs\/\d{4}-\d{2}-\d{2}\.md"/);

    const memberLogPath = path.join(dir, body.saved_paths.member_log_path);
    assert.ok(fs.existsSync(memberLogPath), 'result command should write owner member log');
    const memberLog = fs.readFileSync(memberLogPath, 'utf8');
    assert.match(memberLog, /## \d{2}:\d{2} - Result/);
    assert.match(memberLog, /purpose: Fix signup button/);
    assert.match(memberLog, /try: click signup and confirm the account screen opens/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept prints a concise human landing', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Clarify accept landing', '--tag', 'product', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const ready = runCli([
      'task',
      'ready',
      ref,
      '--as',
      'architect',
      '--proof',
      'node --test test/task-plan-result.test.js passed for accept landing',
      '--changed',
      'made the accept output concise',
      '--checked',
      'accepted a task and read the landing',
      '--saved',
      'task trace and proof stayed on disk',
      '--try',
      'read the accept landing and confirm it says public XP was not published',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const accept = runCli(['task', 'accept', ref, '--reward', '3', '--as', 'keshavrao'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.deepEqual(accept.stdout.trim().split('\n'), [
      'Changed: made the accept output concise',
      'Checked: accepted a task and read the landing; XP updated (3 total); brain scorecards +1',
      'Try: read the accept landing and confirm it says public XP was not published; next mission: none',
    ]);
    assert.doesNotMatch(accept.stdout, /Done:|Proof:|Local:|Public:|career_xp|contribution_graph|accepted .*reward=/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept receipt shows the next active mission route', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.appendFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-route-after-accept',
      slug: 'route-after-accept',
      objective: 'Route accepted proof into the next mission',
      owner: 'mission-lead',
      status: 'planning',
      cadence: 'manual',
      runner: 'codex_goal',
      lane: 'code',
      verifier: 'node -e "process.exit(0)"',
      always_on: false,
      task_ids: [],
      human_asks: [],
      next_action: 'run verifier with `atris mission tick <id> --verify`',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }) + '\n', 'utf8');

    const add = runCli(['task', 'add', 'Route accept landing', '--tag', 'product', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    const ready = runCli([
      'task',
      'ready',
      ref,
      '--as',
      'architect',
      '--proof',
      'node --test test/task-plan-result.test.js passed for route accept landing',
      '--changed',
      'made accept show the next route',
      '--checked',
      'accepted a task with an active mission present',
      '--try',
      'read the accept landing',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const accept = runCli(['task', 'accept', ref, '--reward', '2', '--as', 'keshavrao'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.deepEqual(accept.stdout.trim().split('\n'), [
      'Changed: made accept show the next route',
      'Checked: accepted a task with an active mission present; XP updated (2 total); brain scorecards +1',
      'Try: read the accept landing; next mission: Route accepted proof into the next mission',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task accept --public publishes AgentXP in the same landing', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
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
        public_accepted_count: 1,
        internal_accepted_count: 0,
        accepted_usernames: ['keshavrao'],
        stored_usernames: ['keshavrao'],
        mapped_to_authenticated_user: false,
        private_agentxp: false,
        source: 'sync_upload',
      }));
    });
  });
  try {
    const address = await listen(server);
    const env = {
      ATRIS_TASKS_DB: dbPath,
      ATRIS_AGENT_ID: 'codex',
      ATRIS_API_URL: `http://127.0.0.1:${address.port}/api`,
      ATRIS_AGENTXP_SYNC_TOKEN: 'sync-secret',
    };
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Publish accept landing', '--tag', 'product', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;

    const ready = runCli([
      'task',
      'ready',
      ref,
      '--as',
      'architect',
      '--proof',
      'node --test test/task-plan-result.test.js passed for public accept landing',
      '--changed',
      'made public accept publish AgentXP in one command',
      '--checked',
      'accepted with a fake AgentXP server and saw the publish request succeed',
      '--try',
      'accept a reviewed task with --public',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const accept = await runCliAsync(['task', 'accept', ref, '--reward', '4', '--as', 'keshavrao', '--public'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr || accept.stdout);
    assert.deepEqual(accept.stdout.trim().split('\n'), [
      'Changed: made public accept publish AgentXP in one command',
      'Checked: accepted with a fake AgentXP server and saw the publish request succeed; XP updated (4 total); brain scorecards +1',
      'Try: accept a reviewed task with --public; next mission: none',
    ]);
    assert.doesNotMatch(accept.stdout, /Done:|Proof:|Local:|Public:/);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/api/agentxp/leaderboard/sync');
    assert.equal(captured.token, 'sync-secret');
    assert.equal(captured.body.operator, 'keshavrao');
    assert.equal(captured.body.visibility, 'public');
    assert.equal(captured.body.public_agentxp, true);
  } finally {
    server.close();
    cleanupTempDir(dir);
  }
});

test('task result supports deck PDF and maintenance handoffs', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writeMember(dir, 'architect', {
      role: 'Architect',
      description: 'Shapes workflow improvements from evidence.',
    });

    const cases = [
      {
        title: 'Polish launch deck',
        changed: 'updated the launch deck story',
        checked: 'opened the deck and reviewed slide 3',
        saved: 'task trace and architect log were updated',
        tryNext: 'open slide 3 and check the new story',
      },
      {
        title: 'Check investor PDF',
        changed: 'updated the investor PDF totals page',
        checked: 'opened the PDF and checked the totals page',
        saved: 'task trace and architect log were updated',
        tryNext: 'open the PDF and confirm the totals page looks right',
      },
      {
        title: 'Clean stale task view',
        changed: 'cleaned the stale task view',
        checked: 'ran the task status command',
        saved: 'task trace and architect log were updated',
        tryNext: 'run atris task status and confirm the stale task is gone',
      },
    ];

    for (const item of cases) {
      const add = runCli(['task', 'add', item.title, '--tag', 'product', '--json'], { cwd: dir, env });
      assert.equal(add.status, 0, add.stderr);
      const ref = JSON.parse(add.stdout).task.display_id;
      const plan = runCli([
        'task',
        'plan-preview',
        item.title,
        '--owner',
        'architect',
        '--plan',
        'architect will make the smallest change, check it, and leave a plain result.',
        '--expected',
        'the human gets one concrete thing to try.',
        '--task',
        ref,
        '--json',
      ], { cwd: dir, env });
      assert.equal(plan.status, 0, plan.stderr);

      const result = runCli([
        'task',
        'result',
        ref,
        '--as',
        'architect',
        '--changed',
        item.changed,
        '--checked',
        item.checked,
        '--saved',
        item.saved,
        '--try',
        item.tryNext,
        '--status',
        'ready for review',
        '--json',
      ], { cwd: dir, env });
      assert.equal(result.status, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.deepEqual(body.text.split('\n'), [
        `Changed: ${item.changed}`,
        `Checked: ${item.checked}`,
        `Try: ${item.tryNext}`,
      ]);
      assert.doesNotMatch(body.text, /Purpose:|Owner:|Saved:|Status:|takeoff|landing|router|verifier|harness|model/i);
    }
  } finally {
    cleanupTempDir(dir);
  }
});
