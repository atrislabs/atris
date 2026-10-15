'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cli = path.resolve(__dirname, '../bin/atris.js');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-room-truth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.atris/state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris/team'), { recursive: true });
  return root;
}

function member(root, name, role = 'Builder') {
  const dir = path.join(root, 'atris/team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\n---\n# ${name}\n`);
  return dir;
}

function run(root, ...args) {
  const env = scrubAgentEnv();
  for (const key of Object.keys(env)) {
    if (/^ATRIS_(ROSTER|MACHINE_ROSTER|RUNNER|CLAUDE|CODEX|ROUTER)/.test(key)) delete env[key];
  }
  const result = spawnSync(process.execPath, [cli, 'member', ...args], {
    cwd: root,
    env: { ...env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_ROUTER_EXPLAIN: '0', ATRIS_MACHINE_ROSTER_PATH: path.join(root, 'home/roster.json') },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function mission(root, fields) {
  fs.writeFileSync(path.join(root, '.atris/state/missions.jsonl'), JSON.stringify({
    id: 'mission-room-truth', owner: 'researcher', objective: 'Repair search results',
    status: 'complete', updated_at: '2026-10-14T12:00:00Z', ...fields,
  }) + '\n');
}

test('briefing uses the shared roster picks, including member overrides and models', (t) => {
  const root = project(t);
  member(root, 'researcher', 'Researcher');
  member(root, 'navigator', 'Navigator');
  const { readEngineRegistry } = require('../lib/engine-registry');
  const registry = readEngineRegistry(root);
  for (const engine of registry.engines) engine.health = { status: 'ready' };
  fs.writeFileSync(path.join(root, '.atris/state/engines.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(root, 'atris/ROSTER.md'), '# roster\n\n## search\n- devin\n\n## build\n- claude\n\n## team\n- researcher: claude, model: haiku\n');
  const room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup.find((row) => row.member === 'navigator').engine, 'devin');
  assert.equal(room.standup.find((row) => row.member === 'researcher').engine, 'claude');
  const card = room.members.find((row) => row.member === 'researcher');
  assert.match(card.engine_seat.model, /haiku/);
  assert.equal(card.subagent_shell.engine, 'claude');
  assert.match(run(root, 'day'), /Your team runs on devin and claude\./);
});

test('briefing includes newer members after the familiar members, in stable order', (t) => {
  const root = project(t);
  for (const name of ['zeta', 'architect', 'host', 'navigator']) member(root, name);
  const room = JSON.parse(run(root, 'room', '--json'));
  assert.deepEqual(room.members.map((row) => row.member), ['navigator', 'architect', 'host', 'zeta']);
  assert.deepEqual(room.standup.map((row) => row.member), ['navigator', 'architect', 'host', 'zeta']);
  assert.deepEqual(room.one_on_ones.map((row) => row.member), ['navigator', 'architect', 'host', 'zeta']);
  const text = run(root, 'day');
  assert.match(text, /HOST \(Builder\)/);
  assert.match(text, /ZETA \(Builder\)/);
});

test('the actual mission engine takes precedence over the next roster pick', (t) => {
  const root = project(t);
  member(root, 'researcher');
  fs.writeFileSync(path.join(root, 'atris/ROSTER.md'), '# roster\n\n## build\n- claude\n');
  mission(root, { status: 'running', runner: 'codex', last_summary: 'Repairing search results' });
  let room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].engine, 'codex');
  assert.match(run(root, 'day'), /Your team runs on codex\./);
  mission(root, { status: 'running', runner: 'codex_goal' });
  room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].engine, 'codex');
  mission(root, { status: 'running', runner: 'auto' });
  room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].engine, room.members[0].engine_seat.engine_id);
  mission(root, { runner: 'manual' });
  room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].engine, room.members[0].engine_seat.engine_id);
  assert.doesNotMatch(run(root, 'day'), /engine:manual|runs on manual/);
});

test('a large team briefing reaches the end of stdout as valid JSON', (t) => {
  const root = project(t);
  for (let i = 0; i < 32; i++) member(root, `builder-${i}`, `Builder ${'large team '.repeat(12)}`);
  const output = run(root, 'day', '--json');
  assert.ok(Buffer.byteLength(output) > 65536);
  const room = JSON.parse(output);
  assert.equal(room.members.length, 32);
  assert.equal(room.standup.length, 32);
  assert.equal(room.controls.feed, 'atris member feed');
});

test('briefing and feed remove commit labels before clipping summaries', (t) => {
  const root = project(t);
  const dir = member(root, 'researcher', 'Researcher');
  mission(root, { last_summary: 'Search repaired (commit `a1b2c3d4`) and checked.', verifier_result: { passed: true } });
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs/2026-10-14.md'), '## 09:00 · Mission run tick 1\n- summary: Search repaired (commit: "a1b2c3d4") and checked.\n- verifier: passed\n');
  const room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].latest_update, 'Search repaired and checked.');
  assert.equal(room.feed[0].summary, 'Search repaired and checked.');
  assert.doesNotMatch(run(root, 'day'), /a1b2c3d4|\(commit|\(\s*\)/i);
});

test('a raw error placeholder does not become the update, and failure stays visible', (t) => {
  const root = project(t);
  const dir = member(root, 'researcher');
  mission(root, { last_summary: 'error', verifier_result: { passed: false } });
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs/2026-10-14.md'), '## 09:00 · Mission run tick 1\n- summary: error\n- verifier: failed\n');
  const room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].latest_update, 'Repair search results');
  assert.equal(room.standup[0].status, 'check failed');
  assert.deepEqual(room.feed, []);
  assert.doesNotMatch(run(root, 'day'), /Found:\s+error\b/);
  mission(root, { last_summary: 'Search stopped because the database is unavailable.', status: 'failed' });
  const failed = JSON.parse(run(root, 'day', '--json'));
  assert.match(failed.standup[0].latest_update, /database is unavailable/);
  assert.equal(failed.standup[0].status, 'work stopped');
});

test('no ready engine is reported honestly instead of inventing a claude seat', (t) => {
  const root = project(t);
  member(root, 'researcher');
  // Seed the real registry through the CLI, then mark every configured engine unavailable.
  run(root, 'day', '--json');
  const file = path.join(root, '.atris/state/engines.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const engine of registry.engines) engine.health = { status: 'not_installed', checked_at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(registry));
  const room = JSON.parse(run(root, 'day', '--json'));
  assert.equal(room.standup[0].engine, null);
  assert.equal(room.members[0].subagent_shell.engine, null);
  assert.doesNotMatch(room.members[0].subagent_shell.shell_command, /--engine claude/);
  assert.match(run(root, 'day'), /engine:no ready engine/);
});
