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

test('a codex step carries a codex model pin', () => {
  for (const model of ['gpt-6-sol', 'gpt-6-terra']) {
    const cmd = tickCommand({ runner: 'codex', model });
    assert.match(cmd, new RegExp(`^codex exec --model ${model} `));
  }
});

test('a claude model never reaches codex; codex rides its own default', () => {
  for (const model of ['claude-opus-5-5', 'claude-fable-5', 'opus', 'sonnet', 'haiku', 'fable', 'opus 5.5', 'claude-haiku-4-5[1m]', 'default', 'default[1m]', 'opusplan']) {
    assert.equal(withProfile('codex', () => resolveMissionTickRunnerModel({ runner: 'codex', model })), '', model);
    const cmd = tickCommand({ runner: 'codex', model });
    assert.doesNotMatch(cmd, /--model|-m /, `${model}: ${cmd}`);
    assert.match(cmd, /^codex exec "\$\(cat /);
  }
});

test('a custom codex template never fills its model slot with a claude default', () => {
  const template = { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} exec {modelFlag} {prompt}' };
  for (const env of [template, { ...template, ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }, { ...template, ATRIS_CLAUDE_MODEL: 'sonnet' }]) {
    for (const model of [undefined, 'claude-opus-5-5', 'default']) {
      const cmd = tickCommand({ runner: 'codex', ...(model ? { model } : {}) }, env);
      assert.match(cmd, /^codex exec "\$\(cat /, `${model}: ${cmd}`);
    }
  }
  assert.match(tickCommand({ runner: 'codex', model: 'gpt-6-sol' }, template), /^codex exec --model gpt-6-sol /);
  assert.match(tickCommand({ runner: 'codex' }, { ...template, ATRIS_RUNNER_MODEL: 'gpt-6-terra' }), /^codex exec --model gpt-6-terra /);
});

test('a runner bin named codex is treated as codex even with no profile', () => {
  for (const bin of ['codex', '/opt/tools/bin/codex']) {
    for (const template of ['{bin} exec {modelFlag} {prompt}', '{bin} exec {pinnedModelFlag} {prompt}']) {
      const env = { ATRIS_RUNNER_BIN: bin, ATRIS_RUNNER_COMMAND_TEMPLATE: template };
      for (const model of ['default[1m]', 'claude-opus-5-5']) {
        const cmd = withProfile('', () => buildRunnerCommand({ promptFile: '/tmp/prompt.md', model }), env);
        assert.doesNotMatch(cmd, /--model/, `${bin} ${model}: ${cmd}`);
      }
      const pinned = withProfile('', () => buildRunnerCommand({ promptFile: '/tmp/prompt.md', model: 'gpt-6-sol' }), env);
      assert.match(pinned, /exec --model gpt-6-sol /);
    }
  }
  // The program that runs is what counts, even under a claude profile.
  const env = { ATRIS_RUNNER_BIN: '/opt/bin/codex', ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} exec {modelFlag} {prompt}' };
  const cmd = withProfile('claude', () => buildRunnerCommand({ promptFile: '/tmp/prompt.md', model: 'opus' }), env);
  assert.equal(cmd, '/opt/bin/codex exec "$(cat /tmp/prompt.md)"');
});

test('a dropped model takes a literal model flag in the template with it', () => {
  for (const template of [
    '{bin} exec --model {model} {prompt}',
    '{bin} exec -m {model} {prompt}',
    '{bin} exec --model={model} {prompt}',
    '{bin} exec --model "{model}" {prompt}',
    "{bin} exec --model '{model}' {prompt}",
    '{bin} exec -m{model} {prompt}',
  ]) {
    const env = { ATRIS_RUNNER_COMMAND_TEMPLATE: template };
    const cmd = tickCommand({ runner: 'codex', model: 'claude-opus-5-5' }, env);
    assert.equal(cmd, 'codex exec "$(cat /tmp/prompt.md)"', template);
    assert.match(tickCommand({ runner: 'codex', model: 'gpt-6-sol' }, env), /exec (--model[ =]|-m ?)["']?gpt-6-sol["']? /);
  }
});

test('claude steps keep their model pin', () => {
  assert.match(tickCommand({ runner: 'claude', model: 'claude-opus-5-5' }), /^claude -p .* --model claude-opus-5-5$/);
  assert.match(tickCommand({ runner: 'claude' }), /--model claude-opus-5-5$/);
  assert.match(tickCommand({ runner: 'fable' }), /--model claude-fable-5$/);
  const template = { ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} -p {prompt} {modelFlag}' };
  assert.match(tickCommand({ runner: 'claude' }, template), /--model claude-opus-5-5$/);
  assert.match(tickCommand({ runner: 'claude', model: 'default' }, template), /--model default$/);
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
    CODEX_HOME: path.join(home, '.codex'),
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

// Real mission run: a codex mission whose stored model is a claude name runs
// codex with no model flag, and a codex pin reaches codex as typed.
test('mission run hands codex its own model and never a claude one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-codex-model-'));
  try {
    const binDir = path.join(dir, 'bin');
    const argsLog = path.join(dir, 'codex-args.log');
    writeBin(binDir, 'codex', `printf '%s\\n' "$@" | grep -v '^You are' > "${argsLog}"\necho codex tick`);
    const env = { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` };

    for (const [model, expected] of [['claude-opus-5-5', null], ['gpt-6-sol', 'gpt-6-sol']]) {
      const started = runCli([
        'mission', 'start', `codex model ${model}`, '--owner', 'mission-lead',
        '--runner', 'codex', '--model', model, '--no-verify', '--json',
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
      assert.equal(argv[0], 'exec');
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
