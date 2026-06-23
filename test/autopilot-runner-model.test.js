'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { buildRunnerCommand } = require('../lib/runner-command');

const AUTOPILOT_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'autopilot.js'), 'utf8');
const RUN_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'run.js'), 'utf8');
const MISSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'mission.js'), 'utf8');
const BIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'bin', 'atris.js'), 'utf8');
const CONSOLE_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'console.js'), 'utf8');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- T2/T3 wiring: the heartbeat paths route through the shared builder ---
// (no raw `claude -p "$(cat ...)"` literal may survive, or the spawn would bypass
// model resolution and inherit the CLI's mutable selection — retired-model-kills-loop-silently)

test('autopilot.js and run.js contain no raw claude -p spawn literal', () => {
  const raw = /claude -p "\$\(cat/;
  assert.doesNotMatch(AUTOPILOT_SRC, raw, 'autopilot.js still has a hardcoded claude -p literal');
  assert.doesNotMatch(RUN_SRC, raw, 'run.js still has a hardcoded claude -p literal');
});

test('autopilot.js and run.js build their spawn command via buildRunnerCommand', () => {
  assert.match(AUTOPILOT_SRC, /buildRunnerCommand\(/);
  assert.match(RUN_SRC, /buildRunnerCommand\(/);
  assert.match(AUTOPILOT_SRC, /require\('\.\.\/lib\/runner-command'\)/);
  assert.match(RUN_SRC, /require\('\.\.\/lib\/runner-command'\)/);
});

test('runner availability checks use the shared configured binary', () => {
  assert.doesNotMatch(AUTOPILOT_SRC, /which claude/);
  assert.doesNotMatch(RUN_SRC, /which claude/);
  assert.match(AUTOPILOT_SRC, /buildRunnerAvailabilityCommand\(/);
  assert.match(RUN_SRC, /buildRunnerAvailabilityCommand\(/);
});

test('runtime runner wording is config-neutral', () => {
  assert.doesNotMatch(AUTOPILOT_SRC, /claude -p (hit the wall|returned no JSON|subprocess|call|to inspect)/);
  assert.doesNotMatch(AUTOPILOT_SRC, /install Claude Code first/);
  assert.doesNotMatch(RUN_SRC, /Uses claude -p|Execute a phase using claude -p|Claude runner CLI|install Claude Code first/);
  assert.match(AUTOPILOT_SRC, /configured runner/);
  assert.match(RUN_SRC, /configured runner command/);
});

test('run and autopilot sweep configured runner process groups on timeout', () => {
  for (const src of [AUTOPILOT_SRC, RUN_SRC]) {
    assert.match(src, /function execPhaseCommandSync\(cmd, opts = \{\}\)/);
    assert.match(src, /detached: true/);
    assert.match(src, /process\.kill\(-err\.pid, 'SIGKILL'\)/);
    assert.match(src, /err\.code === 'ETIMEDOUT'/);
  }
});

test('run and autopilot expose runner flags through the bin router', () => {
  assert.match(BIN_SRC, /function applyRunnerFlags\(args\)/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_RUNNER_PROFILE = runnerProfile/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_RUNNER_BIN = runnerBin/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_CLAUDE_BIN = runnerBin/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_RUNNER_COMMAND_TEMPLATE = runnerTemplate/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_CLAUDE_COMMAND_TEMPLATE = runnerTemplate/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_RUNNER_MODEL = runnerModel/);
  assert.match(BIN_SRC, /process\.env\.ATRIS_CLAUDE_MODEL = runnerModel/);
  assert.match(BIN_SRC, /command === 'run'[\s\S]*applyRunnerFlags\(args\)[\s\S]*runAtris/);
  assert.match(BIN_SRC, /command === 'autopilot'[\s\S]*applyRunnerFlags\(args\)[\s\S]*autopilotAtris/);
  assert.match(BIN_SRC, /--runner-bin/);
  assert.match(BIN_SRC, /--runner-template/);
  assert.match(BIN_SRC, /--runner-model/);
  assert.match(BIN_SRC, /--runner-profile/);
  assert.match(BIN_SRC, /!isOptionValue\(args, i, RUNNER_FLAG_NAMES\)/);
});

test('mission claude ticks spawn the configured runner binary', () => {
  assert.doesNotMatch(MISSION_SRC, /spawn\('claude'/);
  assert.doesNotMatch(MISSION_SRC, /spawnSync\('claude'/);
  assert.match(MISSION_SRC, /spawnSync\(runnerBin, \['--help'\]/);
  assert.match(MISSION_SRC, /spawn\(resolveClaudeRunnerBin\(\), args/);
  assert.match(MISSION_SRC, /resolveClaudeRunnerBin/);
});

test('console claude launcher uses the configured runner binary', () => {
  assert.doesNotMatch(CONSOLE_SRC, /spawnSync\('claude'/);
  assert.match(CONSOLE_SRC, /resolveClaudeRunnerBin\(\)/);
  assert.match(CONSOLE_SRC, /spawnSync\(runnerBin, args/);
});

// --- T3: every spawn injects a resolved --model alias by default ---

test('default heartbeat spawn carries --model opus (alias, not a versioned id)', () => {
  withRunnerEnv({}, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
    assert.match(cmd, /--model opus\b/);
    assert.doesNotMatch(cmd, /--model claude-/);
  });
});

// --- T4: a future claude -p change is a one-line config switch (env) ---

test('ATRIS_CLAUDE_MODEL flips the spawned model without touching code', () => {
  withRunnerEnv({ ATRIS_CLAUDE_MODEL: 'sonnet' }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
    assert.match(cmd, /--model sonnet\b/);
  });
});

test('ATRIS_RUNNER_MODEL flips the spawned model without touching code', () => {
  withRunnerEnv({ ATRIS_RUNNER_MODEL: 'glm-5.2', ATRIS_CLAUDE_MODEL: 'opus' }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', allowedTools: 'Bash,Read' });
    assert.match(cmd, /--model glm-5\.2\b/);
  });
});

test('ATRIS_CLAUDE_COMMAND_TEMPLATE flips the command shape without touching code', () => {
  withRunnerEnv({ ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} --print-file {promptFile} {modelFlag} {allowedToolsFlag}' }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp', model: 'opus', allowedTools: 'Bash,Read' });
    assert.equal(cmd, "claude --print-file /tmp/p.tmp --model opus --allowedTools 'Bash,Read'");
    assert.doesNotMatch(cmd, / -p /);
  });
});

test('ATRIS_RUNNER_COMMAND_TEMPLATE flips the command shape without touching code', () => {
  withRunnerEnv({
    ATRIS_RUNNER_COMMAND_TEMPLATE: '{bin} --model {model} --prompt-file {promptFile}',
    ATRIS_RUNNER_MODEL: 'glm-5.2',
    ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt} {modelFlag}',
  }, () => {
    const cmd = buildRunnerCommand({ promptFile: '/tmp/p.tmp' });
    assert.equal(cmd, 'claude --model glm-5.2 --prompt-file /tmp/p.tmp');
    assert.doesNotMatch(cmd, / -p /);
  });
});
