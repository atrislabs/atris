'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playCommand } = require('../commands/play');
const taskDb = require('../lib/task-db');

const STARTER_TITLE = 'AgentXP Mode first rep: complete one proof-backed useful mission';

// Every ATRIS_* var is cleared, and HOME plus the task db point into a temp
// root, so nothing reads or writes the developer's machine.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-play-'));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
  process.env.HOME = path.join(root, 'home');
  process.env.ATRIS_TASKS_DB = path.join(root, 'state', 'tasks.db');

  const workspace = path.join(root, 'workspace');
  // A bare .git dir marks the workspace root, so the lookup stays inside it.
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });

  return {
    workspace,
    dbPath: process.env.ATRIS_TASKS_DB,
    restore() {
      taskDb.close();
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

// Runs playCommand and returns each console.log line it printed.
async function run(...args) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    await playCommand(...args);
  } finally {
    console.log = original;
  }
  return lines;
}

test('help prints usage and does not create the task db', async () => {
  const sb = sandbox();
  try {
    const lines = await run('--help');
    assert.ok(lines.includes('Usage: atris play [--as <player>] [--workspace <path>] [--json]'));
    assert.equal(fs.existsSync(sb.dbPath), false);
  } finally {
    sb.restore();
  }
});

test('first run with --as seeds one starter mission for that player', async () => {
  const sb = sandbox();
  try {
    const lines = await run('--as', 'tester', '--workspace', sb.workspace, '--json');
    const state = JSON.parse(lines.join('\n'));

    assert.equal(state.schema, 'atris.agentxp_play_mode.v1');
    assert.equal(state.player, 'tester');
    assert.equal(state.player_source, 'flag');
    assert.equal(state.workspace_root, fs.realpathSync(sb.workspace));
    assert.equal(state.mission.status, 'open');
    assert.equal(state.mission.title, STARTER_TITLE);
    assert.equal(state.mission.assigned_to, 'tester');
    assert.equal(state.seeded.title, STARTER_TITLE);
    assert.match(state.mission.prompt, /Win condition: one accepted proof-backed rep/);
    assert.equal(state.next_commands[0], `atris task claim ${state.mission.ref} --as tester`);
  } finally {
    sb.restore();
  }
});

test('text output shows the seeded mission and the next commands', async () => {
  const sb = sandbox();
  try {
    const lines = await run('--as', 'tester', '--workspace', sb.workspace);
    const workspaceName = path.basename(fs.realpathSync(sb.workspace));

    assert.equal(lines[1], 'AgentXP Mode');
    assert.equal(lines[2], `Player tester | Workspace ${workspaceName}`);
    assert.equal(lines[3], 'Handle source: --as/--player.');
    assert.ok(lines.some(line => /^Starter mission created locally: \S+$/.test(line)));
    assert.ok(lines.some(line => /^Mission \S+: AgentXP Mode first rep/.test(line)));
    assert.ok(lines.includes('Win condition: real artifact + verifier + human accept.'));
    assert.ok(lines.includes('Next commands:'));
  } finally {
    sb.restore();
  }
});

test('second run reuses the existing mission instead of seeding another', async () => {
  const sb = sandbox();
  try {
    const first = JSON.parse((await run('--as', 'tester', '--workspace', sb.workspace, '--json')).join('\n'));
    const second = JSON.parse((await run('--as', 'tester', '--workspace', sb.workspace, '--json')).join('\n'));

    assert.ok(first.seeded);
    assert.equal(second.seeded, null);
    assert.equal(second.mission.id, first.mission.id);
  } finally {
    sb.restore();
  }
});

test('--no-seed on an empty workspace reports no mission and creates nothing', async () => {
  const sb = sandbox();
  try {
    const lines = await run('--as', 'tester', '--no-seed', '--workspace', sb.workspace);
    assert.ok(lines.includes('No active mission found.'));
    assert.ok(lines.includes('Seed one:'));

    const state = JSON.parse((await run('--as', 'tester', '--no-seed', '--workspace', sb.workspace, '--json')).join('\n'));
    assert.equal(state.mission, null);
    assert.equal(state.seeded, null);
    assert.equal(state.next_commands[0], 'atris task delegate "AgentXP first rep: one proof-backed mission" --to tester --tag agent-xp');
  } finally {
    sb.restore();
  }
});

test('player handle is slugified: case, email domain, and spaces', async () => {
  const sb = sandbox();
  try {
    const state = JSON.parse((await run('--as', 'Justin Lee@corp.example', '--no-seed', '--workspace', sb.workspace, '--json')).join('\n'));
    assert.equal(state.player, 'justin-lee');
    assert.equal(state.player_source, 'flag');
  } finally {
    sb.restore();
  }
});
