'use strict';

// Every way atris launches an engine, built by the real launcher code and run
// through a real shell against stand-in programs, then read back the way the
// team view reads `ps`. A launcher that gains a flag the reader does not know
// fails here instead of quietly hiding runs or naming the wrong model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseEngineProcess } = require('../lib/engine-processes');
const { RUNNER_PROFILE_DEFS, buildRunnerCommand } = require('../lib/runner-command');
const { buildReadOnlyEngineInvocation } = require('../lib/engine-ask');
const { commandForEngine } = require('../commands/agent-spawn');
const { buildEngineCommand } = require('../lib/fleet');

const ROOT = path.join(__dirname, '..');
const PROMPT = 'You are acting as validator. Review the diff for PR 7\nKeep it short.';
const DOING = 'Review the diff for PR 7 Keep it short.';

// The program name at the front of a launch -> the engine the view shows.
const BINARY_ENGINE = {
  codex: 'codex', claude: 'claude', 'cursor-agent': 'cursor', devin: 'devin', grok: 'grok', agy: 'agy',
  opencode: 'opencode', ax: 'atris-fast', cmd: 'commandcode',
};
const MODEL_FOR_BIN = {
  codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5', 'cursor-agent': 'composer-2.5', devin: 'swe-2-max',
  grok: 'grok-4.7', agy: 'gemini-3.8-flash-high', opencode: 'opencode/muse-spark-1.3', cmd: 'cmd-model-2',
};
const RUNNER_ENV = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_COMMAND_TEMPLATE'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-shapes-'));
const binDir = path.join(dir, 'bin');
fs.mkdirSync(binDir);
for (const name of [...Object.keys(BINARY_ENGINE), 'atris']) {
  fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nprintf \'%s\\0\' "$0" "$@"\n', { mode: 0o755 });
}
// Fleet wraps codex in a watchdog; this one just runs what follows "--".
const watchdog = path.join(dir, 'watchdog.js');
fs.writeFileSync(watchdog, "const i = process.argv.indexOf('--');\nrequire('child_process').spawnSync(process.argv[i + 1], process.argv.slice(i + 2), { stdio: 'inherit' });\n");
const promptFile = path.join(dir, 'prompt.md');
fs.writeFileSync(promptFile, PROMPT);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The words a launch really hands its program, after the shell is done.
function shellArgv(command) {
  const result = spawnSync('sh', ['-c', command], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: process.env.HOME },
  });
  assert.equal(result.status, 0, `${command}\n${result.stderr}`);
  const argv = result.stdout.split('\0').slice(0, -1);
  assert.ok(argv.length, `nothing ran: ${command}`);
  return argv;
}

// ps joins the words with spaces and shows a newline as \012.
function psLine(argv) {
  return argv.map((word) => word.replace(/\n/g, '\\012')).join(' ');
}

function settingAfter(argv, names) {
  const at = argv.findIndex((word) => names.includes(word));
  return at === -1 ? null : argv[at + 1];
}

// What the reader must recover, from the real word boundaries.
function expectedFrom(argv) {
  const bin = path.basename(argv[0]);
  const config = argv.find((word) => word.startsWith('model_reasoning_effort='));
  return {
    engine: BINARY_ENGINE[bin],
    model: settingAfter(argv, ['--model', '-m']) || (bin === 'ax' && argv.includes('--fast') ? 'atris:fast' : null),
    effort: settingAfter(argv, ['--effort', '--reasoning-effort', '--variant']) || (config ? config.split('=')[1] : null),
  };
}

function assertReads(label, argv, { member = 'validator', doing = DOING } = {}) {
  const run = parseEngineProcess({ pid: 1, ppid: 0, elapsed_seconds: 5, command: psLine(argv) });
  assert.ok(run, `${label}: the launch was not read as a run\n${psLine(argv)}`);
  assert.deepEqual(
    { engine: run.engine, model: run.model, effort: run.effort, member: run.member, doing: run.doing },
    { ...expectedFrom(argv), member, doing },
    `${label}\n${psLine(argv)}`,
  );
}

function withRunnerEnv(profile, fn) {
  const saved = Object.fromEntries(RUNNER_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNNER_ENV) delete process.env[name];
  if (profile) process.env.ATRIS_RUNNER_PROFILE = profile;
  try { return fn(); } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function effortFor(profile) {
  return (RUNNER_PROFILE_DEFS[profile].efforts || []).includes('high') ? 'high' : '';
}

test('every engine ask launch reads back with its engine, model, effort, and work', () => {
  for (const engine of Object.keys(RUNNER_PROFILE_DEFS)) {
    const bin = RUNNER_PROFILE_DEFS[engine].bin;
    for (const model of [MODEL_FOR_BIN[bin] || '', '']) {
      let invocation;
      try {
        invocation = buildReadOnlyEngineInvocation(engine, PROMPT, model, { effort: effortFor(engine) });
      } catch (error) {
        if (error.reason === 'model_not_supported') continue;
        throw error;
      }
      assertReads(`ask ${engine} ${model}`, [path.join(binDir, invocation.bin), ...invocation.args]);
    }
  }
});

test('every runner profile launch reads back, settings before or after the prompt', () => {
  for (const profile of Object.keys(RUNNER_PROFILE_DEFS)) {
    const bin = RUNNER_PROFILE_DEFS[profile].bin;
    for (const effort of [effortFor(profile), '']) {
      const command = withRunnerEnv(profile, () => buildRunnerCommand({
        promptFile, allowedTools: 'Read,Edit,Bash', model: MODEL_FOR_BIN[bin] || '', effort,
      }));
      assertReads(`runner ${profile} ${effort}`, shellArgv(command));
    }
  }
});

test('every fleet launch reads back, plain, sealed, and yolo', () => {
  for (const profile of Object.keys(RUNNER_PROFILE_DEFS)) {
    const bin = RUNNER_PROFILE_DEFS[profile].bin;
    for (const mode of [{}, { sealed: true }, { yolo: true }]) {
      const command = withRunnerEnv('', () => buildEngineCommand(profile, promptFile, {
        ...mode, watchdogPath: watchdog, model: MODEL_FOR_BIN[bin] || '', effort: effortFor(profile),
      }));
      assertReads(`fleet ${profile} ${JSON.stringify(mode)}`, shellArgv(command));
    }
  }
});

test('every agent spawn launch reads back, including cursor with no -p', () => {
  for (const engine of ['codex', 'claude', 'cursor', 'devin']) {
    const command = commandForEngine({ engine, role: 'reviewer', task: 'Review the diff for PR 7', cwd: '/w' });
    const argv = shellArgv(command);
    assertReads(`spawn ${engine}`, argv, {
      member: null,
      doing: 'You are an Atris delegated reviewer. Workspace: /w Task: Review the diff for PR 7 Do one bounded proof-backed pass. Do not revert unrelated edits. Return changed files, verifier commands, and remaining risk.',
    });
  }
});

test('every launch in the engines skill reads back', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'atris', 'skills', 'engines', 'SKILL.md'), 'utf8');
  const expected = {
    'Atris Fast': 'atris-fast', Claude: 'claude', Codex: 'codex', Cursor: 'cursor', Fable: 'fable', Composer: 'cursor',
    Haiku: 'claude', 'Devin (build)': 'devin', 'Devin (search)': 'devin', Grok: 'grok', 'Antigravity (agy)': 'agy', opencode: 'opencode',
  };
  // The exact-command table: rows whose second column starts with a program.
  const rows = [...skill.matchAll(/^\| ([^|]+?) \| `([a-z][^`]*)`/gm)];
  assert.ok(rows.length >= Object.keys(expected).length, 'the engines skill launch table moved');
  for (const [, name, shape] of rows) {
    assert.ok(expected[name], `the engines skill has a new launch "${name}"; add what it should read as`);
    const command = shape
      .replace(/"<(?:prompt|question)>"/g, `"${PROMPT}"`)
      .replace(/<result-file>/g, path.join(dir, 'result.md'))
      .replace(/<brief>/g, promptFile);
    const argv = shellArgv(command);
    const run = parseEngineProcess({ pid: 1, ppid: 0, elapsed_seconds: 5, command: psLine(argv) });
    assert.ok(run, `${name}: not read as a run\n${psLine(argv)}`);
    const modelWord = settingAfter(argv, ['--model', '-m']);
    const fromFile = argv.includes('--prompt-file');
    assert.deepEqual(
      { engine: run.engine, model: run.model, member: run.member, doing: run.doing },
      {
        engine: expected[name],
        model: modelWord || null,
        member: fromFile ? null : 'validator',
        doing: fromFile ? 'prompt file prompt.md' : DOING,
      },
      `${name}\n${psLine(argv)}`,
    );
  }
});
