const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { formatCodexEvent } = require('../lib/member-progress');
const { withMissionFullJson } = require('./helpers/mission-json');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const RUNNER_ENV = [
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

const started = (id, item) => ({ type: 'item.started', item: { id, ...item } });
const completed = (id, item) => ({ type: 'item.completed', item: { id, ...item } });

// Shapes copied from a real `codex exec --json` run (codex-cli 0.162.1).
test('formatCodexEvent turns codex steps into the same plain lines', () => {
  const cwd = '/work/repo';
  const cmd = (command) => started('item_1', { type: 'command_execution', command, status: 'in_progress' });
  assert.equal(formatCodexEvent(cmd("/bin/zsh -lc 'npm test'"), cwd), 'running: npm test');
  assert.equal(formatCodexEvent(cmd('/bin/bash -lc "node --test a.js\necho done"'), cwd), 'running: node --test a.js');
  assert.equal(formatCodexEvent(cmd('ls -la'), cwd), 'running: ls -la');
  assert.equal(formatCodexEvent(cmd(`/bin/zsh -lc '${'x'.repeat(100)}'`), cwd), `running: ${'x'.repeat(70)}`);
  assert.equal(formatCodexEvent(cmd("/bin/zsh -lc 'rg -n formatToolStep lib'"), cwd), 'searching for formatToolStep');
  assert.equal(formatCodexEvent(cmd(`/bin/zsh -lc "grep -n 'hello' a.txt"`), cwd), 'searching for hello');
  assert.equal(formatCodexEvent(completed('item_2', {
    type: 'file_change',
    changes: [{ path: '/work/repo/lib/a.js', kind: 'update' }, { path: '/work/repo/b.md', kind: 'add' }],
  }), cwd), 'editing lib/a.js, b.md');
  assert.equal(formatCodexEvent(started('item_3', { type: 'web_search', query: 'codex jsonl' }), cwd), 'searching for codex jsonl');
  assert.equal(formatCodexEvent(completed('item_4', { type: 'agent_message', text: 'done' }), cwd), null);
  assert.equal(formatCodexEvent(completed('item_5', { type: 'reasoning', text: 'thinking' }), cwd), null);
  assert.equal(formatCodexEvent({ type: 'turn.completed', usage: { input_tokens: 1 } }, cwd), null);
  assert.equal(formatCodexEvent({ type: 'thread.started', thread_id: 't' }, cwd), null);
  assert.equal(formatCodexEvent(null, cwd), null);
});

function writeBin(binDir, name, body) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

function runCli(args, cwd, env) {
  const clean = scrubAgentEnv(process.env);
  for (const name of RUNNER_ENV) delete clean[name];
  const home = path.join(cwd, 'home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...clean,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      HOME: home,
      ATRIS_TASKS_DB: path.join(cwd, '.atris', 'tasks.db'),
      CODEX_HOME: path.join(home, '.codex'),
      ATRIS_MACHINE_ROSTER_PATH: path.join(home, 'roster.json'),
      ATRIS_MACHINE_ROSTER_MD_PATH: path.join(home, 'roster.md'),
      ATRIS_ROSTER_SESSIONS_DIR: path.join(home, 'roster-sessions'),
      ...env,
    },
  });
}

// One codex tick through the real mission run, with a fake codex on PATH.
function runCodexTick(dir, codexBody) {
  const binDir = path.join(dir, 'bin');
  writeBin(binDir, 'codex', codexBody);
  const env = {
    PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    ATRIS_PROGRESS_DIR: path.join(dir, 'progress'),
  };
  const start = runCli([
    'mission', 'start', 'tidy the readme', '--owner', 'growth', '--runner', 'codex', '--no-verify', '--json',
  ], dir, env);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const mission = JSON.parse(start.stdout).mission;
  const run = runCli(['mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json'], dir, env);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const logFile = path.join(dir, 'progress', 'growth.log');
  return { run, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
}

test('a codex tick writes live steps and keeps its final answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-codex-'));
  try {
    const events = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      completed('item_0', { type: 'agent_message', text: 'I will look first.' }),
      started('item_1', { type: 'command_execution', command: "/bin/zsh -lc 'rg -n needle lib'", status: 'in_progress' }),
      completed('item_1', { type: 'command_execution', command: "/bin/zsh -lc 'rg -n needle lib'", exit_code: 0 }),
      started('item_2', { type: 'command_execution', command: "/bin/zsh -lc 'npm test'", status: 'in_progress' }),
      completed('item_2', { type: 'command_execution', command: "/bin/zsh -lc 'npm test'", exit_code: 0 }),
      completed('item_3', { type: 'file_change', changes: [{ path: '__CWD__/README.md', kind: 'update' }] }),
      completed('item_4', { type: 'agent_message', text: 'codex finished bounded work' }),
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
    ];
    const eventsFile = path.join(dir, 'events.jsonl');
    fs.writeFileSync(eventsFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const argsLog = path.join(dir, 'codex-args.log');
    const { run, log } = runCodexTick(dir, [
      'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "      --json"; echo "  -o, --output-last-message <FILE>"; exit 0; fi',
      `printf '%s\\n' "$@" | grep -v '^You are' > "${argsLog}"`,
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done',
      `sed "s#__CWD__#$(pwd)#g" "${eventsFile}"`,
      'printf "codex finished bounded work\\n" > "$out"',
    ].join('\n'));

    const argv = fs.readFileSync(argsLog, 'utf8').split('\n');
    assert.deepEqual(argv.slice(0, 3), ['exec', '--json', '--output-last-message']);
    assert.match(log, /started: tidy the readme/);
    assert.equal((log.match(/searching for needle/g) || []).length, 1, log);
    assert.equal((log.match(/running: npm test/g) || []).length, 1, log);
    assert.match(log, /editing README\.md/);
    assert.match(log, /finished: ok/);
    assert.ok(!log.includes('I will look first'), log);
    assert.match(run.stderr, /  growth \d\d:\d\d  running: npm test/);
    // The final answer is codex's last message, not the raw event stream.
    assert.match(run.stdout, /codex finished bounded work/);
    assert.ok(!run.stdout.includes('thread.started'), 'raw events never reach the receipt');
    assert.equal(fs.readdirSync(path.join(dir, '.atris', 'state', 'runner-prompts')).length, 0, 'prompt and answer files are cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a codex without the event flag runs exactly as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-progress-codex-old-'));
  try {
    const argsLog = path.join(dir, 'codex-args.log');
    const { run, log } = runCodexTick(dir, [
      'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "  -m, --model <MODEL>"; exit 0; fi',
      `printf '%s\\n' "$@" | grep -v '^You are' > "${argsLog}"`,
      'echo "old codex plain answer"',
    ].join('\n'));
    const argv = fs.readFileSync(argsLog, 'utf8').split('\n');
    assert.equal(argv[0], 'exec');
    assert.ok(!argv.includes('--json'), argv.slice(0, 3).join(' '));
    assert.equal(log, '', 'no live lines without events');
    assert.match(run.stdout, /old codex plain answer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
