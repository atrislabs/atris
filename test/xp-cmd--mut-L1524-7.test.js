'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('session goal exposes the update timestamp from native goal state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-goal-update-'));
  const cwd = process.cwd();
  const env = { ...process.env };
  const log = console.log;
  const exit = process.exit;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    const dbPath = path.join(root, 'state.sqlite');
    process.env.CODEX_STATE_DB = dbPath;
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), 'test workspace\n');
    process.chdir(root);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated_at_ms INTEGER);
        CREATE TABLE thread_goals (
          thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT,
          token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER,
          created_at_ms INTEGER, updated_at_ms INTEGER
        );
      `);
      const updated = Date.parse('2024-03-12T15:30:00.000Z');
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)')
        .run('thread-test', root, 'Native goal', updated);
      db.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('thread-test', 'goal-test', 'Check native goal time', 'active', null, 42, 17, updated - 1000, updated);
    } finally {
      db.close();
    }
    const { xpCommand } = require('../commands/xp');
    const output = [];
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await xpCommand('session', '--workspace', root, '--since', '2024-03-01T00:00:00.000Z',
      '--codex-state', dbPath, '--thread', 'thread-test', '--no-write', '--json');
    const capsule = JSON.parse(output.join('\n'));
    assert.strictEqual(capsule.goals.touched.find(goal => goal.goal_id === 'goal-test').updated_at,
      '2024-03-12T15:30:00.000Z');
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
