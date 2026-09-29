const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { withMissionFullJson } = require('./helpers/mission-json');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { resolveMissionTickRunnerModel } = require('../commands/mission');
const { buildRunnerCommand } = require('../lib/runner-command');

const RUNNER_ENV = [
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withProfile(profile, fn, env = {}) {
  const saved = Object.fromEntries(RUNNER_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNNER_ENV) delete process.env[name];
  if (profile) process.env.ATRIS_RUNNER_PROFILE = profile;
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const name of RUNNER_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

// The command a mission tick would launch for this mission, built the way the
// tick builds it: the mission's engine as the profile, the tick's model.
function tickCommand(mission, env = {}) {
  return withProfile(mission.runner, () => buildRunnerCommand({
    promptFile: '/tmp/prompt.md',
    model: resolveMissionTickRunnerModel(mission),
  }), env);
}

test('a grok step carries a grok model pin', () => {
  for (const model of ['grok-4.7', 'grok-4.7-build-fast']) {
    const cmd = tickCommand({ runner: 'grok', model });
    assert.match(cmd, new RegExp(`^grok --always-approve --model ${model} -p `));
  }
});

test('a claude model never reaches grok; grok rides its own default', () => {
  for (const model of ['claude-opus-5-5', 'claude-fable-5', 'opus', 'sonnet', 'haiku', 'fable', 'opus 5.5', 'claude-haiku-4-5[1m]', 'default', 'default[1m]', 'opusplan']) {
    assert.equal(withProfile('grok', () => resolveMissionTickRunnerModel({ runner: 'grok', model })), '', model);
    const cmd = tickCommand({ runner: 'grok', model });
    assert.doesNotMatch(cmd, /--model|-m /, `${model}: ${cmd}`);
    assert.match(cmd, /^grok --always-approve -p "\$\(cat /);
  }
});

test('a custom grok template never fills its model slot with a claude default', () => {
  const template = { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} {modelFlag} -p {prompt}' };
  for (const env of [template, { ...template, ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }, { ...template, ATRIS_CLAUDE_MODEL: 'sonnet' }]) {
    for (const model of [undefined, 'claude-opus-5-5', 'default']) {
      const cmd = tickCommand({ runner: 'grok', ...(model ? { model } : {}) }, env);
      assert.match(cmd, /^grok -p "\$\(cat /, `${model}: ${cmd}`);
    }
  }
  assert.match(tickCommand({ runner: 'grok', model: 'grok-4.7' }, template), /^grok --model grok-4\.7 -p /);
  assert.match(tickCommand({ runner: 'grok' }, { ...template, ATRIS_RUNNER_MODEL: 'grok-4.6' }), /^grok --model grok-4\.6 -p /);
});

test('a runner bin named grok is treated as grok even with no profile', () => {
  for (const bin of ['grok', '/Users/me/.grok/bin/grok']) {
    for (const template of ['{bin} {modelFlag} -p {prompt}', '{bin} {pinnedModelFlag} -p {prompt}']) {
      const env = { ATRIS_RUNNER_BIN: bin, ATRIS_RUNNER_COMMAND_TEMPLATE: template };
      for (const model of ['default[1m]', 'claude-opus-5-5']) {
        const cmd = withProfile('', () => buildRunnerCommand({ promptFile: '/tmp/prompt.md', model }), env);
        assert.doesNotMatch(cmd, /--model/, `${bin} ${model}: ${cmd}`);
      }
      const pinned = withProfile('', () => buildRunnerCommand({ promptFile: '/tmp/prompt.md', model: 'grok-4.7' }), env);
      assert.match(pinned, /--model grok-4\.7 -p /);
    }
  }
  // The program that runs is what counts, even under a claude profile.
  const env = { ATRIS_RUNNER_BIN: '/opt/bin/grok', ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} {modelFlag} -p {prompt}' };
  const cmd = withProfile('claude', () => buildRunnerCommand({ promptFile: '/tmp/prompt.md', model: 'opus' }), env);
  assert.equal(cmd, '/opt/bin/grok -p "$(cat /tmp/prompt.md)"');
});

test('a dropped model takes a literal model flag in a grok template with it', () => {
  for (const template of [
    '{bin} --model {model} -p {prompt}',
    '{bin} -m {model} -p {prompt}',
    '{bin} --model={model} -p {prompt}',
    '{bin} --model "{model}" -p {prompt}',
  ]) {
    const env = { ATRIS_RUNNER_COMMAND_TEMPLATE: template };
    const cmd = tickCommand({ runner: 'grok', model: 'claude-opus-5-5' }, env);
    assert.equal(cmd, 'grok -p "$(cat /tmp/prompt.md)"', template);
    assert.match(tickCommand({ runner: 'grok', model: 'grok-4.7' }, env), /^grok (--model[ =]|-m )"?grok-4\.7"? -p /);
  }
});

// Engines that can run claude models keep a claude pin: only an engine that
// runs its own vendor's models alone drops it.
test('engines that can run claude models keep a claude pin', () => {
  for (const runner of ['agy', 'cursor', 'devin', 'opencode']) {
    assert.match(tickCommand({ runner, model: 'claude-opus-5-5' }), /--model claude-opus-5-5 /, runner);
  }
});

function writeBin(binDir, name, body) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

// Every state path the CLI can write outside the workspace points into the
// scratch dir, so the run never touches the real task database or home.
function scratchStateEnv(dir) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db'),
    GROK_HOME: path.join(home, '.grok'),
    ATRIS_MACHINE_ROSTER_PATH: path.join(home, 'roster.json'),
    ATRIS_MACHINE_ROSTER_MD_PATH: path.join(home, 'roster.md'),
    ATRIS_ROSTER_SESSIONS_DIR: path.join(home, 'roster-sessions'),
  };
}

function runCli(args, cwd, env) {
  const clean = scrubAgentEnv(process.env);
  for (const name of RUNNER_ENV) delete clean[name];
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...clean, ATRIS_SKIP_UPDATE_CHECK: '1', ...scratchStateEnv(cwd), ...env },
  });
}

// Real mission run: a grok mission whose stored model is a claude name runs
// grok with no model flag, and a grok pin reaches grok as typed.
test('mission run hands grok its own model and never a claude one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-grok-model-'));
  try {
    const binDir = path.join(dir, 'bin');
    const argsLog = path.join(dir, 'grok-args.log');
    writeBin(binDir, 'grok', `printf '%s\\n' "$@" | grep -v '^You are' > "${argsLog}"\necho grok tick`);
    const env = { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` };

    for (const [model, expected] of [['claude-opus-5-5', null], ['grok-4.7', 'grok-4.7']]) {
      const started = runCli([
        'mission', 'start', `grok model ${model}`, '--owner', 'mission-lead',
        '--runner', 'grok', '--model', model, '--no-verify', '--json',
      ], dir, env);
      assert.equal(started.status, 0, started.stderr || started.stdout);
      const mission = JSON.parse(started.stdout).mission;
      assert.equal(mission.model, model);

      fs.rmSync(argsLog, { force: true });
      const run = runCli([
        'mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json',
      ], dir, env);
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.ok(fs.existsSync(path.join(dir, '.atris', 'tasks.db')), 'the run writes its tasks to the scratch database');
      const argv = fs.readFileSync(argsLog, 'utf8').split('\n');
      assert.equal(argv[0], '--always-approve');
      if (expected) {
        assert.equal(argv[1], '--model');
        assert.equal(argv[2], expected);
      } else {
        assert.ok(!argv.includes('--model') && !argv.includes('-m'), argv.slice(0, 3).join(' '));
        assert.ok(!argv.some((word) => /claude|opus/.test(word) && word.length < 40), argv.slice(0, 3).join(' '));
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
