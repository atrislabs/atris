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
    assert.match(agents, /atris task note <id>/);
    assert.match(agents, /atris task ready <id> --proof/);
    assert.match(agents, /atris task accept <id>/);

    const claude = fs.readFileSync(path.join(dir, 'atris', 'CLAUDE.md'), 'utf8');
    assert.match(claude, /## Mission Autonomy/);
    assert.match(claude, /atris mission tick <id> --verify --summary/);
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

test('loop wiki refreshes wiki STATUS and appends wiki log entries', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Temp Repo\n', 'utf8');
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['loop', 'wiki'], { cwd: dir });
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
  assert.match(ax, /max_turns:\s*options\.goalEval \? 1 : \(local \? \(mode === 'fast' \? 8 : 14\) : 1\)/);
  assert.match(ax, /'atris:max'/);
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
  assert.match(res.stdout, /ax \[--max\|--pro\|--fast\|--code-fast\] \[--local\|--cloud\] <message>/);
  assert.match(res.stdout, /--max {3}hosted Atris 2, highest reasoning/);
  assert.match(res.stdout, /--code-fast  Atris Code Fast public lane/);
  assert.doesNotMatch(res.stdout, /run\s+local workspace/);
  assert.doesNotMatch(res.stdout, /Worked for/);
});

test('ax fast chat intercepts atris mission run before backend or model work', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  const objective = 'say hello world then set a new goal';
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const res = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), '--fast', '--chat'], {
      cwd: dir,
      input: `atris mission run ${objective}\nexit\n`,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AX_AUTO_LOG: '0',
        ATRIS_AGENT_ID: 'mission-lead',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris mission started/);
    assert.match(res.stdout, new RegExp(`Goal: ${objective}`));
    assert.match(res.stdout, /Mission: mission-.* - planning - atris2/);
    assert.match(res.stdout, /Atris mission pursued/);
    assert.match(res.stdout, /Ticks: 0\/0/);
    assert.match(res.stdout, /Achieved: no/);
    assert.match(res.stdout, /Blocked: auth-required/);
    assert.match(res.stdout, /Next: atris mission attach-task/);
    assert.doesNotMatch(res.stdout + res.stderr, /Start backend|Worked for|credit|Hello world/);

    const missionLines = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(missionLines.some((mission) => mission.objective === objective && mission.runner === 'atris2'), true);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('ax keeps chat context and file-operation proof readable', () => {
  const ax = require('../ax');
  // Hermetic: backendUrl()/buildRunProfile() read the backend env at call time.
  // Clear ambient overrides (set on the operator's shell / Obelisk) so we assert
  // the built-in default, not whatever backend this machine happens to point at.
  const savedBackend = {
    AX_BACKEND_URL: process.env.AX_BACKEND_URL,
    OBELISK_LOCAL_ATRIS2_BACKEND_URL: process.env.OBELISK_LOCAL_ATRIS2_BACKEND_URL,
    OBELISK_ATRIS2_BACKEND_URL: process.env.OBELISK_ATRIS2_BACKEND_URL,
  };
  delete process.env.AX_BACKEND_URL;
  delete process.env.OBELISK_LOCAL_ATRIS2_BACKEND_URL;
  delete process.env.OBELISK_ATRIS2_BACKEND_URL;
  try {
  const payload = ax.buildPayload('edit config', {
    cwd: '/workspace/demo',
    mode: 'pro',
    history: [
      { role: 'user', content: 'find mode' },
      { role: 'assistant', content: 'mode is in src/config.js' }
    ]
  });

  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.model, 'atris:pro');
  assert.equal(payload.max_turns, 1);
  assert.equal(ax.buildPayload('quick edit', { cwd: '/workspace/demo', mode: 'fast' }).max_turns, 1);
  assert.equal(payload.message, 'edit config');
  assert.deepEqual(payload.previous_messages, [
    { role: 'user', content: 'find mode' },
    { role: 'assistant', content: 'mode is in src/config.js' }
  ]);
  assert.equal(ax.modelForMode('pro'), 'atris:pro');
  assert.equal(ax.modelForMode('fast'), 'atris:fast');
  assert.equal(ax.modelForMode('max'), 'atris:max');
  assert.equal(ax.modelForMode('code-fast'), 'composer-2-5-fast');
  assert.equal(ax.backendUrl(), 'https://api.atris.ai/api/atris2/turn');
  assert.equal(ax.formatPrompt('pro'), 'pro › ');
  assert.equal(ax.formatDuration(6197), '6s');
  assert.equal(ax.formatDoneLine(131000), '— Worked for 2m 11s —');
  assert.equal(ax.formatWorkingLine(2100), '• Working (2s • ctrl-c to interrupt)');
  assert.equal(ax.formatStatusMessage('retrying_with_required_local_tool'), null);
  assert.equal(ax.formatStatusMessage('loading_workspace_context'), 'loading workspace context');
  assert.match(ax.formatHeader({ mode: 'pro', cwd: '/workspace/demo', chat: true }), /Atris 2 Pro chat/);
  assert.doesNotMatch(ax.formatHeader({ mode: 'pro', cwd: '/workspace/demo', chat: true }), /atris:pro/);
  assert.match(ax.formatHeader({ mode: 'pro', cwd: '/workspace/demo', chat: true }), /\/workspace\/demo/);
  assert.deepEqual(ax.buildRunProfile({ mode: 'pro', cwd: '/workspace/demo' }), {
    endpoint: 'https://api.atris.ai/api/atris2/turn',
    mode: 'pro',
    route: 'cloud',
    model: 'atris:pro',
    workspace_path: 'cloud',
    max_turns: 1,
    member_slug: 'ax',
    bypass_permissions: false,
    streaming: true,
    runtime: 'authenticated cloud connectors/chat',
    reasoning: 'Atris cloud service; Pro workspace tool loop uses API default medium'
  });
  assert.match(ax.formatRunProfile(ax.buildRunProfile({ mode: 'pro', cwd: '/workspace/demo' })), /thinking\s+Atris cloud service/);
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
    'local workspace  thinking medium'
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
  assert.equal(writes.join(''), '● Task(status)\n');
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
  } finally {
    for (const [k, v] of Object.entries(savedBackend)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

test('default entry gathers first-contact context before MAP bootstrap', () => {
  const dir = makeTempDir();
  try {
    const env = {
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      NODE_NO_WARNINGS: '1',
    };
    runCli(['init'], { cwd: dir, input: '\n', env });

    const res = runCli([], { cwd: dir, input: 'help me organize college applications\n', env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Context gatherer/);
    assert.match(res.stdout, /Got it\. I saved your first direction/);
    assert.match(res.stdout, /First task:/);
    assert.match(res.stdout, /NEXT SETUP STEP/i);
    assert.match(res.stdout, /MAP\.md/i);
    assert.match(fs.readFileSync(path.join(dir, '.atris', 'state', 'context_profile.json'), 'utf8'), /college applications/);
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8'), /First useful step: help me organize college applications/);
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

    // Mark first-contact done so the default entry renders the history view
    // instead of the (correct, but unrelated) onboarding gatherer that fires
    // for a profile-less workspace with no active work. Keeps this test hermetic.
    const profilePath = path.join(dir, '.atris', 'state', 'context_profile.json');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({ first_answer: 'coding', source: 'first_contact' }), 'utf8');

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

test('skill create rejects flag-shaped names instead of making a junk folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['skill', 'create', '--help'], { cwd: dir });
    assert.match(res.stdout + res.stderr, /Usage: atris skill create/);
    // The bug: it used to create atris/skills/--help/SKILL.md.
    assert.ok(!fs.existsSync(path.join(dir, 'atris', 'skills', '--help')), 'must not create a "--help" skill folder');
  } finally {
    cleanupTempDir(dir);
  }
});

test('align --help prints usage even when a business is bound', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'test-co' }), 'utf8');
    const res = runCli(['align', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris align/);
    // The bug: --help got overwritten by the bound slug and it tried a real align.
    assert.doesNotMatch(res.stdout + res.stderr, /Aligning test-co/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('bare ax shows usage instead of "Unknown command"', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['ax'], { cwd: dir });
    assert.doesNotMatch(res.stdout + res.stderr, /Unknown command/);
    assert.match(res.stdout + res.stderr, /atris ax fast/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('ax fast intercepts atris mission run as a local Atris goal', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  const objective = 'say hello world then set a new goal';
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const res = runCli(['ax', 'fast', `atris mission run ${objective} --no-run`], {
      cwd: dir,
      env: { HOME: home, ATRIS_AGENT_ID: 'mission-lead' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris mission started/);
    assert.match(res.stdout, new RegExp(`Goal: ${objective}`));
    assert.match(res.stdout, /Mission: mission-.* - planning - atris2/);
    assert.match(res.stdout, /Pursuing: not run \(--no-run\)/);
    assert.match(res.stdout, /Achieved: no/);
    assert.match(res.stdout, /Next: atris mission attach-task/);
    assert.doesNotMatch(res.stdout + res.stderr, /Not logged in|Atris2 Fast|Worked for|credit/);

    const goalState = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'state', 'atris_goal.json'), 'utf8'));
    assert.equal(goalState.goal.objective, objective);
    assert.equal(goalState.goal.runner, 'atris2');
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('ax fast chat opens clean without stale Atris goal banner', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    const missionId = 'mission-2026-06-29-stale-continuation';
    const mission = {
      schema: 'atris.mission.v1',
      id: missionId,
      objective: 'Decide and start the next useful mission after: old smoke',
      status: 'planning',
      runner: 'atris2',
      next_action: 'atris mission attach-task mission-2026-06-29-stale-continuation --json',
      created_at: '2026-06-29T23:00:00.000Z',
      started_from: 'mission_run_continuation',
    };
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify(mission)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'atris_goal.json'), JSON.stringify({
      schema: 'atris.goal_controller.v1',
      goal: {
        objective: mission.objective,
        mission_id: missionId,
        mission_status: 'planning',
        runner: 'atris2',
        next_command: mission.next_action,
        created_at: mission.created_at,
      },
    }), 'utf8');

    const res = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), '--fast', '--chat'], {
      cwd: dir,
      input: 'exit\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AX_AUTO_LOG: '0',
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris 2 Fast chat/);
    assert.doesNotMatch(res.stdout, /Atris goal:/);
    assert.doesNotMatch(res.stdout, /Decide and start the next useful mission/);
    assert.doesNotMatch(res.stdout, /Next: atris mission attach-task/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
  }
});

test('atris chat intercepts mission run before selected-agent auth', () => {
  const dir = makeTempDir();
  const home = makeTempDir();
  const objective = 'atris chat local mission';
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const res = runCli(['chat', `atris mission run ${objective} --no-run`], {
      cwd: dir,
      env: { HOME: home, ATRIS_AGENT_ID: 'mission-lead' },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris mission started/);
    assert.match(res.stdout, new RegExp(`Goal: ${objective}`));
    assert.match(res.stdout, /Pursuing: not run \(--no-run\)/);
    assert.match(res.stdout, /Achieved: no/);
    assert.doesNotMatch(res.stdout + res.stderr, /No agent selected|Agent:|pro-chat|Worked for|credit/);
  } finally {
    cleanupTempDir(dir);
    cleanupTempDir(home);
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
    assert.match(res.stdout, /Atris Review is the human checkpoint/);
    assert.match(res.stdout, /CERTIFIED REVIEW QUEUE/);
    assert.doesNotMatch(res.stdout, /clear completed tasks out of TODO/);
    assert.match(res.stdout, /Need the legacy Validator prompt\? Run `atris review --verbose`/);
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
