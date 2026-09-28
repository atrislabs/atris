'use strict';

// Fixes a reviewer confirmed on the roster-coverage work: a bare engine ask
// was taking the search line's model (questions are not searches), a claude
// error result came back with empty report text, the fleet live log held all
// of claude's stdout until the run ended, and an autopilot phase's time cap
// ignored the prep pass that ran inside it. Every room is a scratch project
// with a scratch home, fake engines sit on PATH, and the real ~/.atris is
// never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const TASK = {
  display_id: 'CLI-901',
  status: 'open',
  title: 'Fix the widget. Done: widget renders once. Check: node --test test/widget.test.js.',
};

async function withRoom(fn, { roster = '' } = {}) {
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-fleet-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-fleet-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-fleet-bin-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ask-fleet-wt-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['init', '-q', wt]);
  fs.mkdirSync(path.join(root, 'atris'));
  if (roster) fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), roster);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  readEngineRegistry(root);
  for (const name of ['devin', 'grok', 'cursor', 'codex', 'claude', 'haiku']) setEngineHealth(name, 'ready', root);
  try {
    return await fn({ root, home, bin, wt });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin, wt]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A fake engine: logs that it ran and every argument it got (the prompt
// rides in as an argument), then prints its output. `json` is printed instead
// when the launch asks for --output-format json.
function fakeEngine(bin, name, { stdout = '', json = '', exit = 0 } = {}) {
  const file = path.join(bin, name);
  fs.writeFileSync(`${file}.out`, stdout);
  fs.writeFileSync(`${file}.json`, json);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo "${name}" >> "${path.join(bin, 'calls.log')}"`,
    `printf '%s\\n' "$@" > "${file}.args"`,
    `if [ -s "${file}.json" ]; then for a in "$@"; do if [ "$a" = "--output-format" ]; then cat "${file}.json"; exit ${exit}; fi; done; fi`,
    `cat "${file}.out"`,
    `exit ${exit}`,
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

function calls(bin) {
  const file = path.join(bin, 'calls.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function argsOf(bin, name) {
  const file = path.join(bin, `${name}.args`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function runs(root) {
  return require('../lib/roster-runs').readRosterRuns(root, { now: Date.now() + 3600000 });
}

async function askEngine(args, root) {
  const { runEngineAskCommand } = require('../lib/engine-ask');
  const originalLog = console.log;
  const logs = [];
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    const code = await runEngineAskCommand(args, root);
    return { code, logs };
  } finally {
    console.log = originalLog;
  }
}

// --- 1. engine ask takes the ask job's pin, not the search line -------------

test('a bare ask with only a search line runs the engine default, not the search model', async () => {
  const roster = '# roster\n\n## search\n- claude, model: haiku, effort: low\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'claude', { stdout: 'the answer is 42\n' });
    const { code, logs } = await askEngine(['what is the answer', '--engine', 'claude'], root);
    assert.equal(code, 0, logs.join('\n'));
    const args = argsOf(bin, 'claude');
    assert.match(args, /\n--model\nclaude-opus-5-5\n/);
    assert.doesNotMatch(args, /haiku/);
    assert.doesNotMatch(args, /\n--effort\n/);
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].job, rows[0].engine, rows[0].outcome, rows[0].source], ['ask', 'claude', 'landed', 'ask']);
  }, { roster });
});

test('an ask job that lists this engine pins its model and effort', async () => {
  const roster = '# roster\n\n## ask (like search)\n- claude, model: haiku, effort: low\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'claude', { stdout: 'the answer is 42\n' });
    const { code, logs } = await askEngine(['what is the answer', '--engine', 'claude'], root);
    assert.equal(code, 0, logs.join('\n'));
    assert.match(argsOf(bin, 'claude'), /\n--model\nhaiku\n--effort\nlow\n/);
    const rows = runs(root);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].job, rows[0].engine, rows[0].model, rows[0].effort], ['ask', 'claude', 'haiku', 'low']);
  }, { roster });
});

test('an ask job that lists another engine leaves this one unpinned', async () => {
  const roster = '# roster\n\n## ask (like search)\n- codex, effort: high\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'claude', { stdout: 'the answer is 42\n' });
    const { code, logs } = await askEngine(['what is the answer', '--engine', 'claude'], root);
    assert.equal(code, 0, logs.join('\n'));
    const args = argsOf(bin, 'claude');
    assert.match(args, /\n--model\nclaude-opus-5-5\n/);
    assert.doesNotMatch(args, /\n--effort\n/);
  }, { roster });
});

test('--model still wins over the ask job pin', async () => {
  const roster = '# roster\n\n## ask (like search)\n- claude, model: haiku, effort: low\n';
  await withRoom(async ({ root, bin }) => {
    fakeEngine(bin, 'claude', { stdout: 'the answer is 42\n' });
    const { code, logs } = await askEngine(['what is the answer', '--engine', 'claude', '--model', 'opus'], root);
    assert.equal(code, 0, logs.join('\n'));
    const args = argsOf(bin, 'claude');
    assert.match(args, /\n--model\nopus\n/);
    assert.doesNotMatch(args, /haiku/);
  }, { roster });
});
