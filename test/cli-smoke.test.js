const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const taskDb = require('../lib/task-db');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cli-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(env || {}),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function seedOwnerGatedZeroShotProjection(dir) {
  const stateDir = path.join(dir, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
    schema: 'atris.task_projection.v1',
    tasks: [
      {
        display_id: 'CZS-1',
        title: 'Add atris zero-shot CLI command',
        status: 'review',
        tag: 'cli',
        review: {
          approval_status: 'pending',
          agent_certified: true,
          handoff: { next_action: 'human_accept_waiting' },
        },
      },
    ],
  }, null, 2));
}

test('init creates structured TODO and feature templates', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['init'], { cwd: dir, input: '\n' });
    assert.equal(res.status, 0, res.stderr);

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    assert.ok(fs.existsSync(todoPath), 'TODO.md should exist');
    const todo = fs.readFileSync(todoPath, 'utf8');
    assert.match(todo, /## Backlog/);
    assert.match(todo, /## In Progress/);
    assert.match(todo, /## Completed/);

    const templatesDir = path.join(dir, 'atris', 'features', '_templates');
    assert.ok(fs.existsSync(path.join(templatesDir, 'idea.md.template')));
    assert.ok(fs.existsSync(path.join(templatesDir, 'build.md.template')));
    assert.ok(fs.existsSync(path.join(templatesDir, 'validate.md.template')));

    const wikiDir = path.join(dir, 'atris', 'wiki');
    assert.ok(fs.existsSync(path.join(wikiDir, 'wiki.md')));
    assert.ok(fs.existsSync(path.join(wikiDir, 'index.md')));
    assert.ok(fs.existsSync(path.join(wikiDir, 'log.md')));
    assert.ok(fs.existsSync(path.join(wikiDir, 'STATUS.md')));

    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /## Mission Autonomy/);
    assert.match(agents, /atris mission status --status active --json/);
    assert.match(agents, /OpenClaw/);
    assert.match(agents, /Agent Contract/);
    assert.match(agents, /atris 0-shot --prompt/);
    assert.match(agents, /atris 0-shot --json/);
    assert.match(agents, /atris task note <id>/);
    assert.match(agents, /atris task ready <id> --proof/);
    assert.match(agents, /atris task accept <id>/);

    const claude = fs.readFileSync(path.join(dir, 'atris', 'CLAUDE.md'), 'utf8');
    assert.match(claude, /## Mission Autonomy/);
    assert.match(claude, /atris 0-shot --prompt/);
    assert.match(claude, /atris 0-shot --json/);
    assert.match(claude, /atris mission tick <id> --verify --summary/);

    const rootClaude = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.match(rootClaude, /atris 0-shot --prompt/);
    assert.match(rootClaude, /atris 0-shot --json/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('log writes numbered inbox items (I#)', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['log'], { cwd: dir, input: 'First idea\nexit\n' });
    assert.equal(res.status, 0, res.stderr);

    const logsDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logsDir);
    assert.ok(yearDirs.length > 0, 'logs year directory should exist');

    const yearDir = path.join(logsDir, yearDirs[0]);
    const logFiles = fs.readdirSync(yearDir).filter((f) => f.endsWith('.md'));
    assert.ok(logFiles.length > 0, 'a log file should be created');

    const content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');
    assert.match(content, /- \*\*I1:\*\*\s+First idea/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('activate prints core file paths', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['activate'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Activate — Context Loaded/);
    assert.match(res.stdout, /atris[\\/]+TODO\.md/);
    assert.match(res.stdout, /atris[\\/]+wiki[\\/]+STATUS\.md/);
    assert.match(res.stdout, /Wiki:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris.md boot visualization does not create an empty daily journal', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'atris.md'), '# atris.md\n', 'utf8');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# MAP.md\n\n- `bin/atris.js`\n', 'utf8');
    fs.writeFileSync(
      path.join(atrisDir, 'TODO.md'),
      ['# TODO.md', '', '## Backlog', '', '## In Progress', '', '## Completed', ''].join('\n'),
      'utf8'
    );

    const res = runCli(['atris.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /WORKSPACE DETECTED/);
    assert.equal(fs.existsSync(path.join(atrisDir, 'logs')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris.md boot visualization does not create a task DB just to count tasks', () => {
  const dir = makeTempDir();
  const dbPath = path.join(dir, '.atris-test', 'tasks.db');
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'atris.md'), '# atris.md\n', 'utf8');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# MAP.md\n\n- `bin/atris.js`\n', 'utf8');
    fs.writeFileSync(
      path.join(atrisDir, 'TODO.md'),
      ['# TODO.md', '', '## Backlog', '', '- markdown fallback task', '', '## In Progress', '', '## Completed', ''].join('\n'),
      'utf8'
    );

    const res = runCli(['atris.md'], { cwd: dir, env: { ATRIS_TASKS_DB: dbPath } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Tasks:\s+1 backlog, 0 active/);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris.md boot visualization prefers task DB counts over stale TODO rows', () => {
  const dir = makeTempDir();
  const oldDb = process.env.ATRIS_TASKS_DB;
  const dbPath = path.join(dir, '.atris-test', 'tasks.db');
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'atris.md'), '# atris.md\n', 'utf8');
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'), '# MAP.md\n\n- `bin/atris.js`\n', 'utf8');
    fs.writeFileSync(
      path.join(atrisDir, 'TODO.md'),
      ['# TODO.md', '', '## Backlog', '', '- stale markdown task', '', '## In Progress', '', '## Completed', ''].join('\n'),
      'utf8'
    );

    process.env.ATRIS_TASKS_DB = dbPath;
    const db = taskDb.open(dbPath);
    taskDb.addTask(db, {
      title: 'Authoritative claimed task',
      workspaceRoot: taskDb.workspaceRoot(dir),
      status: 'claimed',
      claimedBy: 'codex'
    });
    taskDb.close();

    const res = runCli(['atris.md'], { cwd: dir, env: { ATRIS_TASKS_DB: dbPath } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Tasks:\s+0 backlog, 1 active/);
    assert.match(res.stdout, /TODO\.md ←── 0 tasks waiting/);
  } finally {
    taskDb.close();
    if (oldDb === undefined) delete process.env.ATRIS_TASKS_DB;
    else process.env.ATRIS_TASKS_DB = oldDb;
    cleanupTempDir(dir);
  }
});

test('skill list and audit include bundled skills from any workspace', () => {
  const dir = makeTempDir();
  try {
    const localSkillDir = path.join(dir, 'atris', 'skills', 'local-only');
    fs.mkdirSync(localSkillDir, { recursive: true });
    fs.writeFileSync(path.join(localSkillDir, 'SKILL.md'), [
      '---',
      'name: local-only',
      'description: Use when testing local project skill discovery from a temporary workspace.',
      'version: 1.0.0',
      'tags:',
      '  - test',
      '---',
      '',
      '# Local Only',
      '',
      '1. Check the local workspace.',
      '2. Keep the proof bounded.',
      '',
    ].join('\n'), 'utf8');

    const list = runCli(['skill', 'list'], { cwd: dir });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /local-only/);
    assert.match(list.stdout, /x-search/);
    assert.match(list.stdout, /calendar/);

    const audit = runCli(['skill', 'audit', 'x-search'], { cwd: dir });
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /Audit: x-search/);
    assert.match(audit.stdout, /Score: 12\/12/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('loop refreshes wiki STATUS and appends wiki log entries', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Temp Repo\n', 'utf8');
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
    assert.match(res.stdout, /Health:/);
    assert.match(res.stdout, /Next move:/);

    const statusPath = path.join(dir, 'atris', 'wiki', 'STATUS.md');
    const logPath = path.join(dir, 'atris', 'wiki', 'log.md');
    const status = fs.readFileSync(statusPath, 'utf8');
    const log = fs.readFileSync(logPath, 'utf8');

    assert.match(status, /Last loop: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(status, /Health:/);
    assert.match(status, /Next move:/);
    assert.match(log, /LOOP/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('natural-language entry passes request into plan output', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const res = runCli(['build', 'a', 'thing'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /DIRECT REQUEST/);
    assert.match(res.stdout, /build a thing/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('plan ignores legacy local execution config unless Atris 2 alias is present', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', '.config'), '{"execution_mode":"local"}\n', 'utf8');

    const res = runCli(['plan'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris Plan - Navigator Agent Activated|Atris Plan .* Navigator Agent Activated/);
    assert.doesNotMatch(res.stderr, /Cannot read properties/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('natural-language prompts containing 2 fast do not trigger Atris 2 alias', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const res = runCli(['make', '2', 'fast', 'smoke', 'tests'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /DIRECT REQUEST/);
    assert.match(res.stdout, /make 2 fast smoke tests/);
    assert.doesNotMatch(res.stdout, /EXECUTING VIA ATRIS 2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('ax is a self-contained Atris2 local/cloud agent script', () => {
  const ax = fs.readFileSync(path.join(repoRoot, 'ax'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.match(ax, /path:\s*'\/api\/atris2\/turn'/);
  assert.match(ax, /path:\s*'\/api\/cursor\/turn'/);
  assert.match(ax, /payload\.workspace_path = options\.cwd \|\| process\.cwd\(\)/);
  assert.match(ax, /function resolveRoute/);
  assert.match(ax, /model:\s*modelForMode\(mode\)/);
  assert.match(ax, /function buildCodeFastPayload/);
  assert.match(ax, /function postCodeFastTurn/);
  assert.match(ax, /function modelForMode/);
  assert.match(ax, /function buildRunProfile/);
  assert.match(ax, /function formatSystemInit/);
  assert.match(ax, /max_turns:\s*local \? \(mode === 'pro' \? 14 : 8\) : 1/);
  assert.match(ax, /Accept:\s*'text\/event-stream'/);
  assert.match(ax, /async function chat/);
  assert.doesNotMatch(ax, /\/api\/agent-sdk\/fast/);
  assert.doesNotMatch(ax, /atris2-fast-local/);
  assert.equal(pkg.bin.ax, 'ax');
  assert.ok(pkg.files.includes('ax'), 'published package must include the ax entrypoint');
  assert.ok(pkg.files.includes('templates/'), 'published package must include workspace templates');
});

test('ax help stays local and does not start an agent turn', () => {
  const res = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ax - Atris local\/code agent/);
  assert.match(res.stdout, /ax \[--pro\|--fast\|--code-fast\] \[--local\|--cloud\] <message>/);
  assert.match(res.stdout, /--code-fast  Atris Code Fast public lane/);
  assert.doesNotMatch(res.stdout, /run\s+local workspace/);
  assert.doesNotMatch(res.stdout, /Worked for/);
});

test('ax keeps chat context and file-operation proof readable', () => {
  const ax = require('../ax');
  const payload = ax.buildPayload('edit config', {
    cwd: '/workspace/demo',
    mode: 'pro',
    history: [
      { role: 'user', content: 'find mode' },
      { role: 'assistant', content: 'mode is in src/config.js' }
    ]
  });

  assert.equal(payload.workspace_path, '/workspace/demo');
  assert.equal(payload.model, 'atris:pro');
  assert.equal(payload.max_turns, 14);
  assert.equal(ax.buildPayload('quick edit', { cwd: '/workspace/demo', mode: 'fast' }).max_turns, 8);
  assert.match(payload.message, /Recent conversation/);
  assert.equal(ax.modelForMode('pro'), 'atris:pro');
  assert.equal(ax.modelForMode('fast'), 'atris:fast');
  assert.equal(ax.modelForMode('code-fast'), 'composer-2-5-fast');
  assert.equal(ax.backendUrl(), 'http://127.0.0.1:8000/api/atris2/turn');
  assert.equal(ax.formatPrompt('pro'), '› ');
  assert.equal(ax.formatDuration(6197), '6s');
  assert.equal(ax.formatDoneLine(131000), '— Worked for 2m 11s —');
  assert.equal(ax.formatWorkingLine(2100), '• Working (2s • ctrl-c to interrupt)');
  assert.equal(ax.formatStatusMessage('retrying_with_required_local_tool'), null);
  assert.equal(ax.formatStatusMessage('loading_workspace_context'), 'loading workspace context');
  assert.match(ax.formatHeader({ mode: 'pro', cwd: '/workspace/demo', chat: true }), /Atris 2 Pro chat \(atris:pro\)/);
  assert.match(ax.formatHeader({ mode: 'pro', cwd: '/workspace/demo', chat: true }), /\/workspace\/demo/);
  assert.deepEqual(ax.buildRunProfile({ mode: 'pro', cwd: '/workspace/demo' }), {
    endpoint: 'http://127.0.0.1:8000/api/atris2/turn',
    mode: 'pro',
    route: 'local',
    model: 'atris:pro',
    workspace_path: '/workspace/demo',
    max_turns: 14,
    streaming: true,
    runtime: 'local workspace',
    reasoning: 'backend reports run row; Pro workspace tool loop uses API default medium'
  });
  assert.match(ax.formatRunProfile(ax.buildRunProfile({ mode: 'pro', cwd: '/workspace/demo' })), /thinking\s+backend reports run row/);
  assert.equal(
    ax.formatSystemInit({
      type: 'system_init',
      model: 'gpt-5.5',
      tool_runtime: {
        mode: 'local_workspace',
        tool_model: 'openai:gpt-5.5',
        reasoning_effort: 'medium'
      }
    }),
    'local workspace  openai:gpt-5.5  thinking medium'
  );
  assert.deepEqual(
    ax.parseSseBlock('data: {"type":"text_delta","content":"ok"}\n\n'),
    { type: 'text_delta', content: 'ok' }
  );
  assert.equal(
    ax.summarizeToolInput({ tool: 'Grep', input: { pattern: 'mode', path: '.' } }),
    'Grep  mode  in  .'
  );
  assert.equal(
    ax.summarizeToolInput({ tool: 'Read', input: { file_path: 'src/config.js' } }),
    'Read  src/  config.js'
  );
  assert.equal(ax.formatPathSubject('src/components/Message.tsx'), 'src/components/  Message.tsx');
  assert.equal(
    ax.summarizeToolResult({ content: '{"status":"ok","path":".","files":["ax"],"dirs":["test"]}' }),
    '1 files / 1 dirs  in  .'
  );

  const writes = [];
  const output = { isTTY: false, write: (chunk) => writes.push(chunk) };
  const state = {
    events: [],
    errors: [],
    output: '',
    pendingText: '',
    wroteText: false,
    wroteActivity: false,
    lastChar: '\n',
    progress: null
  };
  ax.handleEvent({
    type: 'system_init',
    model: 'gpt-5.5',
    tool_runtime: {
      mode: 'local_workspace',
      tool_model: 'openai:gpt-5.5',
      reasoning_effort: 'medium'
    }
  }, state, output);
  ax.handleEvent({ type: 'text_delta', content: 'What would you like me to inspect?' }, state, output);
  ax.handleEvent({ type: 'status', message: 'retrying_with_required_local_tool' }, state, output);
  ax.handleEvent({ type: 'assistant_blocks', blocks: [{ type: 'tool_use', tool: 'Task', input: { type: 'status' } }] }, state, output);
  assert.equal(writes.join(''), '  run   local workspace  openai:gpt-5.5  thinking medium\n\n  tool  Task  status\n');
  assert.equal(state.output, '');

  const ttyWrites = [];
  const ttyOutput = { isTTY: true, write: (chunk) => ttyWrites.push(chunk) };
  const ttyState = {
    events: [],
    errors: [],
    output: '',
    pendingText: '',
    wroteText: false,
    wroteActivity: false,
    lastChar: '\n',
    progress: null,
    inAuxBlock: false
  };
  ax.handleEvent({ type: 'text_delta', content: 'streaming' }, ttyState, ttyOutput);
  assert.equal(ttyWrites.join(''), 'streaming');
  assert.equal(ttyState.output, 'streaming');
});

test('ax prepends zero-shot handoff context for fast/pro/code-fast turns', () => {
  const ax = require('../ax');
  const zeroShotPacket = {
    decision: {
      lane: 'owner_gate',
      horizon: 'blocked',
      model_tier: 'human',
      selected_ref: 'CZS-1',
      selected_title: 'Add atris zero-shot CLI command',
      reason: 'CZS-1 is agent-certified and waiting for human accept.',
      owner_action: 'human-only: atris task accept CZS-1',
      safe_agent_action: 'read-only: atris task page CZS-1 --json',
    },
    commands: {
      first_command: 'atris task page CZS-1 --json',
      zero_shot_all: 'atris 0-shot --all',
      zero_shot_prompt: 'atris 0-shot --prompt',
      model_prompt: {
        fast: 'atris 0-shot --model fast --prompt',
        pro: 'atris 0-shot --model pro --prompt',
        validator: 'atris 0-shot --model validator --prompt',
        human: 'atris 0-shot --model human --prompt',
      },
      horizon_prompt: {
        now: 'atris 0-shot --horizon now --prompt',
        review: 'atris 0-shot --horizon review --prompt',
        long: 'atris 0-shot --horizon long --prompt',
        blocked: 'atris 0-shot --horizon blocked --prompt',
        orient: 'atris 0-shot --horizon orient --prompt',
      },
    },
    routes: {
      models: { fast: { count: 2 }, pro: { count: 1 }, validator: { count: 1 }, human: { count: 1 } },
      horizons: { now: 2, immediate_review: 1, long_term: 1, blocked: 1, orient: 0 },
    },
  };

  const fastPayload = ax.buildPayload('what next?', {
    cwd: '/workspace/demo',
    mode: 'fast',
    zeroShotPacket,
  });
  assert.match(fastPayload.message, /^0-shot context for this ax turn:/);
  assert.match(fastPayload.message, /ax mode: fast/);
  assert.match(fastPayload.message, /route: owner_gate \| blocked \| human/);
  assert.match(fastPayload.message, /run first: atris task page CZS-1 --json/);
  assert.match(fastPayload.message, /model buckets: fast=2 pro=1 validator=1 human=1/);
  assert.match(fastPayload.message, /horizon buckets: now=2 review=1 long=1 blocked=1 orient=0/);
  assert.match(fastPayload.message, /owner gate: human-only: atris task accept CZS-1/);
  assert.match(fastPayload.message, /do only the agent-safe action/);
  assert.match(fastPayload.message, /User request:\nwhat next\?/);

  const codeFastPayload = ax.buildCodeFastPayload('inspect quickly', {
    cwd: '/workspace/demo',
    zeroShotPacket,
  });
  assert.match(codeFastPayload.message, /ax mode: code-fast/);
  assert.match(codeFastPayload.message, /prompt: atris 0-shot --prompt/);
});

test('default entry auto-advances to plan when inbox has items', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
    // Clear the bootstrap backlog task so only inbox items remain
    const logDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logDir).filter(d => /^\d{4}$/.test(d));
    if (yearDirs.length > 0) {
      const yearDir = path.join(logDir, yearDirs[0]);
      const logFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));
      if (logFiles.length > 0) {
        let content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');
        content = content.replace(/## Backlog\n[\s\S]*?(?=\n---|\n##)/, '## Backlog\n\n');
        fs.writeFileSync(path.join(yearDir, logFiles[0]), content, 'utf8');
      }
    }
    // Also clear TODO.md backlog
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    if (fs.existsSync(todoPath)) {
      let todo = fs.readFileSync(todoPath, 'utf8');
      todo = todo.replace(/## Backlog\n[\s\S]*?(?=\n---|\n##)/, '## Backlog\n\n(Empty)\n\n');
      fs.writeFileSync(todoPath, todo, 'utf8');
    }
    runCli(['log'], { cwd: dir, input: 'Idea one\nexit\n' });

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Plan — Navigator Agent Activated/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry prompts for MAP bootstrap when MAP.md is placeholder', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /BOOTSTRAP/i);
    assert.match(res.stdout, /MAP\.md/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry auto-advances to do when backlog tasks exist', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(
      todoPath,
      `# TODO.md\n\n## Backlog\n\n- implement thing\n\n## In Progress\n\n(Empty)\n\n## Completed\n\n(Empty)\n`,
      'utf8'
    );

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Do — Executor Agent Activated/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry treats completed-only TODO rows as history', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(
      todoPath,
      `# TODO.md\n\n## Backlog\n\n(Empty)\n\n## In Progress\n\n(Empty)\n\n## Completed\n\n- validate thing\n`,
      'utf8'
    );

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Completed \(history\):/);
    assert.match(res.stdout, /Completed tasks are history, not pending review\./);
    assert.doesNotMatch(res.stdout, /Next: atris review|I checked the review setup\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry routes active work before completed history', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(
      todoPath,
      `# TODO.md\n\n## Backlog\n\n- build the useful thing\n\n## In Progress\n\n(Empty)\n\n## Completed\n\n- validate old thing\n`,
      'utf8'
    );

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Completed \(history\):/);
    assert.match(res.stdout, /Backlog \(preview\):/);
    assert.match(res.stdout, /Next: atris do \(work ready to execute\)/);
    assert.doesNotMatch(res.stdout, /Next: atris review|I checked the review setup\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('help lists essential commands', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris init/);
    assert.match(res.stdout, /atris run/);
    assert.match(res.stdout, /atris soul/);
    assert.match(res.stdout, /atris fleet/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('--help flag shows help', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('status --quick reflects inbox count', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    let res = runCli(['status', '--quick'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /📋\s+\d+\s+\|\s+🔨\s+\d+\s+\|\s+✅\s+\d+\s+\|\s+📥\s+\d+/);

    runCli(['log'], { cwd: dir, input: 'Idea one\nexit\n' });
    res = runCli(['status', '--quick'], { cwd: dir });
    assert.match(res.stdout, /📥\s+1/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('plan suggests brainstorm when uncertainty detected', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    runCli(['log'], { cwd: dir, input: "not sure what to build yet\nexit\n" });

    const res = runCli(['plan'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Try `atris brainstorm` first/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('workflow agents stop at owner-gated zero-shot route before instructions or execution', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    seedOwnerGatedZeroShotProjection(dir);

    let res = runCli(['plan'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /route: owner_gate \| blocked \| human/);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not starting plan\./);
    assert.match(res.stdout, /Run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT/);
    assert.doesNotMatch(res.stdout, /You are the Navigator/);

    res = runCli(['do'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /route: owner_gate \| blocked \| human/);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not starting do\./);
    assert.match(res.stdout, /Run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT/);
    assert.doesNotMatch(res.stdout, /You are the Executor/);

    res = runCli(['review', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not starting review\./);
    assert.match(res.stdout, /Run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT/);
    assert.doesNotMatch(res.stdout, /You are the Validator/);

    res = runCli(['review', '--execute'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not starting review\./);
    assert.doesNotMatch(res.stdout, /AGENT MODE: Executing via backend API/);
    assert.doesNotMatch(res.stderr, /Not logged in|Authentication failed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('run stops at owner-gated zero-shot route before automation', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    seedOwnerGatedZeroShotProjection(dir);

    const res = runCli(['run', '--once', '--no-push'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /route: owner_gate \| blocked \| human/);
    assert.match(res.stdout, /owner-gated 0-shot route detected\. not starting autonomous run\./);
    assert.match(res.stdout, /run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stdout, /planning/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('autopilot stops at owner-gated zero-shot route before selecting work', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    seedOwnerGatedZeroShotProjection(dir);

    const res = runCli(['autopilot', 'new request', '--dry-run', '--iterations=1'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /route: owner_gate \| blocked \| human/);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not starting autopilot\./);
    assert.match(res.stdout, /Run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stdout, /I added this request to the inbox/);
    assert.doesNotMatch(res.stdout, /I picked task/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('chat stops at owner-gated zero-shot route before remote agent auth', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    seedOwnerGatedZeroShotProjection(dir);

    const res = runCli(['chat', 'what now?'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /route: owner_gate \| blocked \| human/);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not opening remote chat\./);
    assert.match(res.stdout, /Run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stderr, /No agent selected|Not logged in/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('brainstorm stops at owner-gated zero-shot route before inbox writes', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    seedOwnerGatedZeroShotProjection(dir);

    const res = runCli(['brainstorm', 'new idea'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0-shot preflight:/);
    assert.match(res.stdout, /route: owner_gate \| blocked \| human/);
    assert.match(res.stdout, /Owner-gated 0-shot route detected\. I am not starting brainstorm\./);
    assert.match(res.stdout, /Run first: atris task page CZS-1 --json/);
    assert.doesNotMatch(res.stdout, /Added I\d+ to today's Inbox/);
    assert.doesNotMatch(res.stderr, /Not logged in|Authentication failed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('do prints concise executor prompt by default', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['do'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /COPY\/PASTE PROMPT/);
    assert.match(res.stdout, /You are the Executor/);
    assert.doesNotMatch(res.stdout, /EXECUTOR SPEC — How to Build/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('do --full includes full executor dumps', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['do', '--full'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /EXECUTOR SPEC \(full\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review prints concise validator prompt by default', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['review'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /I checked the review setup\./);
    assert.match(res.stdout, /refresh the task\s+projection\/TODO view/);
    assert.doesNotMatch(res.stdout, /clear completed tasks out of TODO/);
    assert.match(res.stdout, /Decision:/);
    assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review --full includes full validator dumps', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['review', '--full'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /VALIDATOR SPEC \(full\)/);
    assert.match(res.stdout, /Confirm active task state is clean/);
    assert.doesNotMatch(res.stdout, /delete completed tasks|DELETE completed tasks/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('update migrates TASK_CONTEXTS.md to TODO.md', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const atrisDir = path.join(dir, 'atris');
    const todoPath = path.join(atrisDir, 'TODO.md');
    const legacyPath = path.join(atrisDir, 'TASK_CONTEXTS.md');

    fs.writeFileSync(legacyPath, '# TASK_CONTEXTS.md\n\n## Backlog\n\n- legacy task\n', 'utf8');
    fs.rmSync(todoPath);

    const res = runCli(['update'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(todoPath), 'TODO.md should exist after migration');
    assert.ok(!fs.existsSync(legacyPath), 'TASK_CONTEXTS.md should be migrated away');
  } finally {
    cleanupTempDir(dir);
  }
});

// ── Soul tests ──────────────────────────────────────────

test('soul displays project identity after init', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    const res = runCli(['soul'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /SOUL/);
    assert.match(res.stdout, /IDENTITY/);
    assert.match(res.stdout, /KNOWLEDGE/);
    assert.match(res.stdout, /LEARNED/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('soul snapshot exports JSON and auto-gitignores', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    const res = runCli(['soul', 'snapshot'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);

    const snapshotPath = path.join(dir, 'atris', 'soul-snapshot.json');
    assert.ok(fs.existsSync(snapshotPath), 'soul-snapshot.json should exist');

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert.ok(snapshot.timestamp, 'snapshot should have timestamp');
    assert.ok(snapshot.identity, 'snapshot should have identity');
    assert.ok(snapshot.knowledge, 'snapshot should have knowledge');

    // Check gitignore was updated
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      assert.match(gitignore, /soul-snapshot\.json/);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('soul fork copies persona and policies to target', () => {
  const source = makeTempDir();
  const target = makeTempDir();
  try {
    runCli(['init'], { cwd: source, input: '\n' });
    runCli(['init'], { cwd: target, input: '\n' });

    const res = runCli(['soul', 'fork', target], { cwd: source });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Soul forked/);

    // Genealogy should exist in target
    const genealogyPath = path.join(target, 'atris', 'genealogy.json');
    assert.ok(fs.existsSync(genealogyPath), 'genealogy.json should exist in target');
    const genealogy = JSON.parse(fs.readFileSync(genealogyPath, 'utf8'));
    assert.ok(genealogy.forked_from, 'genealogy should record source');
    assert.ok(genealogy.forked_at, 'genealogy should record timestamp');
  } finally {
    cleanupTempDir(source);
    cleanupTempDir(target);
  }
});

// ── Fleet tests ─────────────────────────────────────────

test('fleet command loads without error (hub may be down)', () => {
  const res = runCli(['fleet', 'status']);
  // May fail with "hub not running" but should not crash
  assert.ok(res.status === 0 || res.status === 1, 'fleet should exit cleanly');
});

test('help shows 6 essential commands', () => {
  const res = runCli(['help']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris init/);
  assert.match(res.stdout, /atris run/);
  assert.match(res.stdout, /atris soul/);
  assert.match(res.stdout, /atris fleet/);
  assert.match(res.stdout, /atris status/);
  assert.match(res.stdout, /--all/);
});
