'use strict';

// Build work starts claude slim: no account-wide tool servers and no user
// settings layer (plugins, personal hooks, personal instructions). Because
// that drops the user-level Claude spend guard hook, the hook's decision runs
// in process first. The tick receipt says which model really ran, how long
// the model took and the tokens in and out. Every run here uses a stand-in
// claude and a scratch home, so the real claude and the real ~/.claude are
// never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildRunnerCommand, slimLaunchSpendStop } = require('../lib/runner-command');
const runs = require('../lib/roster-runs');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const SLIM = ['--strict-mcp-config', '--setting-sources', 'project,local'];
const RUNNER_ENV = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_RUNNER_KEEP_MCP',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ATRIS_CLAUDE_KEY_OK', 'CLAUDE_CONFIG_DIR', 'HOME'];

const RESULT_EVENT = {
  type: 'result',
  result: '## Receipt\n- Fixed the off-by-one in the widget.',
  total_cost_usd: 0.25,
  duration_api_ms: 8123,
  num_turns: 5,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 80000, output_tokens: 900 },
  modelUsage: {
    'claude-haiku-5-5': { inputTokens: 40, outputTokens: 12, costUSD: 0.001 },
    'claude-opus-5-5': { inputTokens: 81500, outputTokens: 900, costUSD: 0.249 },
  },
};

function room() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-slim-launch-'));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'project', 'atris', 'team', 'executor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project', 'atris', 'team', 'executor', 'MEMBER.md'), '---\nname: executor\nrole: builds\n---\n# executor\n');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const argvFile = path.join(dir, 'argv.json');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--output-format --permission-mode --resume --session-id --include-partial-messages'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
const flag = args.includes('--session-id') ? '--session-id' : '--resume';
const sessionId = args[args.indexOf(flag) + 1] || 'fake-session';
console.log(JSON.stringify({ type: 'system', session_id: sessionId }));
console.log(JSON.stringify({ ...${JSON.stringify(RESULT_EVENT)}, session_id: sessionId }));
`, { mode: 0o755 });
  return { dir, home, bin, project: path.join(dir, 'project'), argvFile };
}

// The shape `atris spend guard install` leaves in a home.
function installGuard(home) {
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  const script = path.join(home, '.claude', 'hooks', 'claude-spend-guard.js');
  fs.writeFileSync(script, '');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${script}` }] }] },
  }));
}

function cli(r, args, env = {}) {
  const inherited = { ...process.env };
  for (const name of RUNNER_ENV) delete inherited[name];
  delete inherited.ATRIS_MEMBER_KEEP_MCP;
  delete inherited.ATRIS_MISSION_DRIVER_DETACHED;
  delete inherited.ATRIS_MISSION_DRIVER_PARENT_PID;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: r.project,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...inherited, HOME: r.home, CLAUDE_CONFIG_DIR: path.join(r.home, '.claude'), ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${r.bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function runTick(r, owner, env = {}) {
  const started = cli(r, ['mission', 'start', '--no-verify', 'fix the widget', '--owner', owner,
    '--model', 'claude-opus-5-5', '--verify', 'node -e "process.exit(0)"', '--json'], env);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const mission = JSON.parse(started.stdout).mission;
  const run = cli(r, ['mission', 'run', mission.id, '--max-ticks', '1', '--json'], env);
  assert.equal(run.stdout.trimStart().startsWith('{'), true, run.stderr || run.stdout);
  return JSON.parse(run.stdout).ticks[0];
}

function launchedArgs(r) {
  return fs.existsSync(r.argvFile) ? JSON.parse(fs.readFileSync(r.argvFile, 'utf8')) : null;
}

function hasSlim(args) {
  const at = args.indexOf('--setting-sources');
  return args.includes('--strict-mcp-config') && at !== -1 && args[at + 1] === 'project,local';
}

function withRunnerEnv(values, fn) {
  const saved = Object.fromEntries(RUNNER_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNNER_ENV) if (name !== 'HOME') delete process.env[name];
  Object.assign(process.env, values);
  if (values.HOME) process.env.CLAUDE_CONFIG_DIR = path.join(values.HOME, '.claude');
  try { return fn(); } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a code member tick starts slim and its receipt says what really ran', () => {
  const r = room();
  try {
    const tick = runTick(r, 'executor');
    const args = launchedArgs(r);
    assert.ok(args, 'claude never started');
    assert.equal(hasSlim(args), true, args.join(' '));
    assert.equal(tick.claude.ok, true, JSON.stringify(tick.claude));
    assert.equal(tick.claude.model_ran, 'claude-opus-5-5');
    assert.equal(tick.claude.duration_api_ms, 8123);
    assert.equal(tick.claude.tokens_in, 81500);
    assert.equal(tick.claude.tokens_out, 900);
    assert.equal(tick.claude.num_turns, 5);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('a non-code member and the opt-out keep the full launch', () => {
  for (const [owner, env] of [['mission-lead', {}], ['executor', { ATRIS_MEMBER_KEEP_MCP: '1' }]]) {
    const r = room();
    try {
      runTick(r, owner, env);
      const args = launchedArgs(r);
      assert.ok(args, `${owner}: claude never started`);
      assert.equal(args.includes('--setting-sources'), false, `${owner}: ${args.join(' ')}`);
      assert.equal(args.includes('--strict-mcp-config'), false, `${owner}: ${args.join(' ')}`);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  }
});

test('with no guard hook installed a slim tick carrying a pay-per-use key launches as before', () => {
  const r = room();
  try {
    const tick = runTick(r, 'executor', { ANTHROPIC_API_KEY: 'sk-test-not-real' });
    const args = launchedArgs(r);
    assert.ok(args, 'claude never started');
    assert.equal(hasSlim(args), true, args.join(' '));
    assert.equal(tick.claude.ok, true, JSON.stringify(tick.claude));
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('a slim code member tick carrying a pay-per-use key never starts where the guard is installed', () => {
  const r = room();
  try {
    installGuard(r.home);
    const tick = runTick(r, 'executor', { ANTHROPIC_API_KEY: 'sk-test-not-real' });
    assert.equal(launchedArgs(r), null, 'claude started anyway');
    assert.equal(tick.claude.ok, false);
    assert.equal(tick.claude.reason, 'claude-spend-blocked');
    assert.match(tick.claude.summary, /pay-per-use key/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('a dispatched claude launch starts slim; the opt-out and other programs keep their shape', () => {
  const r = room();
  try {
    withRunnerEnv({ HOME: r.home }, () => {
      const slim = buildRunnerCommand({ promptFile: '/tmp/p.md', model: 'claude-opus-5-5', allowedTools: 'Bash,Read,Edit,Write' });
      assert.ok(slim.endsWith(`--allowedTools 'Bash,Read,Edit,Write' ${SLIM.join(' ')}`), slim);
    });
    withRunnerEnv({ HOME: r.home, ATRIS_RUNNER_KEEP_MCP: '1' }, () => {
      assert.doesNotMatch(buildRunnerCommand({ promptFile: '/tmp/p.md', model: 'claude-opus-5-5' }), /--setting-sources|--strict-mcp-config/);
    });
    withRunnerEnv({ HOME: r.home, ATRIS_RUNNER_BIN: 'my-claude-shaped-cli' }, () => {
      assert.doesNotMatch(buildRunnerCommand({ promptFile: '/tmp/p.md', model: 'claude-opus-5-5' }), /--setting-sources|--strict-mcp-config/);
    });
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('the in-process stop blocks a pay-per-use key launch only where the guard hook is installed', () => {
  const r = room();
  try {
    const env = { HOME: r.home, ANTHROPIC_API_KEY: 'sk-test-not-real' };
    // No hook installed: nothing was stopping this launch before, so nothing does now.
    assert.equal(slimLaunchSpendStop({ model: 'claude-haiku-5-5', env }), '');
    installGuard(r.home);
    assert.match(slimLaunchSpendStop({ model: 'claude-haiku-5-5', env }), /pay-per-use key/);
    assert.equal(slimLaunchSpendStop({ model: 'claude-haiku-5-5', env: { HOME: r.home } }), '');
    withRunnerEnv(env, () => {
      assert.throws(() => buildRunnerCommand({ promptFile: '/tmp/p.md', model: 'claude-haiku-5-5' }), /pay-per-use key/);
    });
    withRunnerEnv({ ...env, ATRIS_RUNNER_KEEP_MCP: '1' }, () => {
      // The full launch keeps the hook, so the hook decides as before.
      assert.match(buildRunnerCommand({ promptFile: '/tmp/p.md', model: 'claude-haiku-5-5' }), /^claude -p /);
    });
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('the run line records the model that ran and keeps the asked one when they differ', () => {
  const usage = runs.parseRunUsage({ usage: RESULT_EVENT.usage, cost_usd: 0.25, model_usage: RESULT_EVENT.modelUsage });
  assert.equal(usage.model_ran, 'claude-opus-5-5');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-slim-runs-'));
  try {
    spawnSync('git', ['init', '-q', dir]);
    const asked = runs.appendRosterRun(dir, { engine: 'claude', outcome: 'landed', model: 'opus', ...usage });
    assert.equal(asked.model, 'claude-opus-5-5');
    assert.equal(asked.requested_model, 'opus');
    assert.equal('model_ran' in asked, false);
    const matched = runs.appendRosterRun(dir, { engine: 'claude', outcome: 'landed', model: 'claude-opus-5-5', ...usage });
    assert.equal(matched.model, 'claude-opus-5-5');
    assert.equal('requested_model' in matched, false);
    const unknown = runs.appendRosterRun(dir, { engine: 'claude', outcome: 'landed', model: 'opus' });
    assert.equal(unknown.model, 'opus');
    const read = runs.readRosterRuns(dir);
    assert.equal(read[0].requested_model, 'opus');
    // A worker pinned to the asked name still counts the run that ran as another id.
    assert.equal(runs.workerRuns(read, { job: 'build', engine: 'claude', model: 'opus' }).length, 2);
    assert.equal(runs.workerRuns(read, { job: 'build', engine: 'claude', model: 'claude-opus-5-5' }).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
