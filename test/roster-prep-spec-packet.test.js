'use strict';

// The spec prep pass: a fast search lead turns one plain goal into a checked
// spec packet, and every miss falls back without throwing. Each room is a
// scratch project with a scratch home; the ask is injected, so no real
// engine runs and the real ~/.atris is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENV_KEYS = [
  'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_ROSTER_SESSION',
  'ATRIS_ROSTER_SESSIONS_DIR', 'ATRIS_CODEX_MODELS_CACHE_PATH', 'ATRIS_CODEX_CONFIG_PATH',
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_ENGINE_COOLDOWN_MINUTES',
  'PATH',
];

const ROSTER = `# roster

## search
- claude, model: haiku, effort: low, max: 2 min

## build
- cursor, max: 20 min, prep: search
`;

const GOAL = 'Add a dry run flag to the sweep command';

async function withRoom(fn) {
  const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-spec-prep-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-spec-prep-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-spec-prep-bin-'));
  spawnSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), ROSTER);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) if (key !== 'PATH') delete process.env[key];
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.PATH = `${bin}${path.delimiter}${saved.get('PATH') || ''}`;
  readEngineRegistry(root);
  for (const name of ['cursor', 'codex', 'claude', 'haiku']) setEngineHealth(name, 'ready', root);
  try {
    return await fn({ root, bin });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [root, home, bin]) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readRuns(root) {
  const file = path.join(root, '.atris', 'state', 'roster_runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const SPEC = {
  files: ['commands/sweep.js', 'test/sweep.test.js'],
  contract: ['commands/sweep.js:40 sweepCommand reads --dry-run and lists without deleting'],
  verify: 'node --test test/sweep.test.js',
  antiGoals: ['lib/engine-ask.js'],
  excerpts: ['commands/sweep.js:40 function sweepCommand(args) {'],
};

test('parseSpecPrepJson reads plain, fenced and wrapped json and refuses the rest', () => {
  const { parseSpecPrepJson } = require('../lib/roster-prep');
  const plain = parseSpecPrepJson(JSON.stringify(SPEC));
  assert.deepEqual(plain, SPEC);
  assert.deepEqual(parseSpecPrepJson(`\`\`\`json\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``), SPEC);
  assert.deepEqual(parseSpecPrepJson(`Here is the spec:\n${JSON.stringify(SPEC)}\nDone.`), SPEC);
  const messy = parseSpecPrepJson(JSON.stringify({ files: [' a.js ', '', 3], verify: ' node --test a.js ', contract: 'x' }));
  assert.deepEqual(messy, { files: ['a.js'], contract: [], verify: 'node --test a.js', antiGoals: [], excerpts: [] });
  assert.equal(parseSpecPrepJson('just some prose, no json'), null);
  assert.equal(parseSpecPrepJson(''), null);
  assert.equal(parseSpecPrepJson('[1, 2]'), null);
  assert.equal(parseSpecPrepJson(JSON.stringify({ verify: 'node --test a.js' })), null);
  assert.equal(parseSpecPrepJson(JSON.stringify({ files: ['a.js'] })), null);
  assert.equal(parseSpecPrepJson(JSON.stringify({ files: [], verify: 'node --test a.js' })), null);
});

test('specPrepPrompt asks for json only, forbids edits and pipes, and carries hints', () => {
  const { specPrepPrompt } = require('../lib/roster-prep');
  const prompt = specPrepPrompt({ goal: `  ${GOAL}  `, hints: ['look at commands/sweep.js', ''] });
  assert.match(prompt, /Goal: Add a dry run flag to the sweep command\n/);
  assert.match(prompt, /atris\/MAP\.md/);
  assert.match(prompt, /ONLY one valid JSON object/);
  assert.match(prompt, /Do not edit, create, or delete/);
  assert.match(prompt, /\.atris\//);
  assert.match(prompt, /atris\/TODO\.md/);
  assert.match(prompt, /tail, grep/);
  assert.match(prompt, /Hints:\n- look at commands\/sweep\.js$/m);
  assert.doesNotMatch(specPrepPrompt({ task: { title: GOAL } }), /Hints:/);
  assert.match(specPrepPrompt({ task: { title: GOAL } }), /Goal: Add a dry run/);
});

test('runSpecPrepPass asks the search lead at low effort and compiles a spec packet', async () => {
  await withRoom(async ({ root }) => {
    const { runSpecPrepPass } = require('../lib/roster-prep');
    const asks = [];
    let now = 1000;
    const result = await runSpecPrepPass({
      goal: GOAL,
      root,
      clock: () => (now += 500),
      ask: async (request) => {
        asks.push(request);
        return {
          ok: true,
          reason: 'ok',
          stdout: `\`\`\`json\n${JSON.stringify(SPEC)}\n\`\`\``,
          stderr: '',
          usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 300 },
          cost_usd: 0.002,
        };
      },
    });
    assert.equal(asks.length, 1);
    assert.equal(asks[0].effort, 'low');
    assert.equal(asks[0].engine, 'claude');
    assert.match(asks[0].prompt, /ONLY one valid JSON object/);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.mode, 'spec_packet');
    assert.equal(result.job, 'search');
    assert.equal(result.duration_ms, 500);
    assert.deepEqual(result.packet.files, SPEC.files);
    assert.equal(result.packet.verify, SPEC.verify);
    assert.equal(result.packet.effort, 'low');
    for (const heading of ['## Goal', '## Files in scope', '## Verify (run bare, never piped)', '## Excerpts']) {
      assert.ok(result.prompt.includes(heading), heading);
    }
    assert.equal(result.brief, result.prompt);
    const runs = readRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].source, 'prep');
    assert.equal(runs[0].job, 'search');
    assert.equal(runs[0].outcome, 'landed');
    assert.equal(runs[0].input_tokens, 100);
    assert.equal(runs[0].output_tokens, 40);
    assert.equal(runs[0].cache_read_tokens, 300);
    assert.equal(runs[0].cost_usd, 0.002);
  });
});

test('runSpecPrepPass falls back on prose, piped verify, forbidden paths, a throw or no goal', async () => {
  await withRoom(async ({ root }) => {
    const { runSpecPrepPass } = require('../lib/roster-prep');
    const answer = (stdout) => async () => ({ ok: true, reason: 'ok', stdout, stderr: '' });
    const cases = [
      [answer('I looked around and the sweep command lives in commands/sweep.js.'), /not valid spec json/],
      [answer(JSON.stringify({ ...SPEC, verify: 'node --test a.js | tail' })), /never piped/],
      [answer(JSON.stringify({ ...SPEC, files: ['.atris/state/x.json', 'commands/sweep.js'] })), /forbidden/],
      [answer(JSON.stringify({ ...SPEC, files: ['atris/TODO.md'] })), /forbidden/],
      [async () => { throw new Error('boom'); }, /failed/],
    ];
    for (const [ask, reason] of cases) {
      const result = await runSpecPrepPass({ goal: GOAL, root, ask });
      assert.equal(result.ok, false);
      assert.equal(result.mode, 'fallback');
      assert.equal(result.packet, null);
      assert.equal(result.prompt, '');
      assert.match(result.reason, reason);
      assert.ok(result.errors.length >= 1);
    }
    const empty = await runSpecPrepPass({ goal: '  ', root, ask: answer('{}') });
    assert.deepEqual(empty.errors, ['goal is required']);
    assert.equal(empty.mode, 'fallback');
    const self = await runSpecPrepPass({ goal: GOAL, prepJob: 'build', root });
    assert.equal(self.mode, 'fallback');
    assert.match(self.reason, /cannot prep for itself/);
  });
});

test('prep asks start light with no web on claude and on the fast tier on codex', async () => {
  const { buildReadOnlyEngineInvocation } = require('../lib/engine-ask');
  for (const engine of ['claude', 'haiku']) {
    const invocation = buildReadOnlyEngineInvocation(engine, 'read', '', { timeoutMs: 1000, effort: 'low', noWeb: true, context: 'light' });
    assert.ok(invocation.args.includes('--safe-mode'), engine);
    const format = invocation.args.indexOf('--output-format');
    assert.equal(invocation.args[format + 1], 'json');
    assert.equal(invocation.jsonResult, true);
    assert.ok(!invocation.args.join(' ').includes('WebSearch'), engine);
  }
  const codex = buildReadOnlyEngineInvocation('codex', 'read', '', { timeoutMs: 1000, effort: 'low', noWeb: true, service_tier: 'fast' });
  assert.ok(codex.args.join(' ').includes('-c service_tier="fast"'));
  assert.ok(codex.args.includes('--ignore-user-config'));

  // defaultPrepAsk itself, against a stand-in codex that echoes its args.
  await withRoom(async ({ root, bin }) => {
    const fake = path.join(bin, 'codex');
    fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
    fs.chmodSync(fake, 0o755);
    const { defaultPrepAsk } = require('../lib/roster-prep');
    const answer = await defaultPrepAsk({ engine: 'codex', model: '', effort: '', prompt: 'read', cwd: root, timeoutMs: 10000 });
    assert.equal(answer.ok, true, answer.stderr);
    assert.match(answer.stdout, /^service_tier="fast"$/m);
    assert.match(answer.stdout, /^--ignore-user-config$/m);
  });
});
