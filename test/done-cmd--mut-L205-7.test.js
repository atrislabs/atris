'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../lib/task-db');
const { doneAtris } = require('../commands/done');

test('completion retains the task owner when no actor is supplied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-acceptor-'));
  const saved = { ...process.env };
  const cwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.USER = 'beth';
    process.env.LOGNAME = 'beth';
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    const db = tasks.open();
    const { id } = tasks.addTask(db, { title: 'Build a page', workspaceRoot: root, status: 'claimed', claimedBy: 'alex' });
    db.prepare('UPDATE tasks SET created_at = ?, claimed_at = ? WHERE id = ?')
      .run(1577836800000, 1577923200000, id);
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: [
      { ...tasks.getTask(db, id), display_id: 'T42' }
    ] }));
    const file = path.join(root, 'index.html');
    fs.writeFileSync(file, '<html><form><input name="email"></form></html>');
    fs.utimesSync(file, new Date('2020-01-03T00:00:00Z'), new Date('2020-01-03T00:00:00Z'));
    const output = [];
    doneAtris(['T42', '--json'], { root, builder: 'claude', log: line => output.push(line) });
    const runs = path.join(root, 'atris', 'runs');
    const receipt = JSON.parse(fs.readFileSync(path.join(runs, fs.readdirSync(runs).find(name => name.endsWith('.json'))), 'utf8'));
    assert.strictEqual(receipt.accepted.by, 'alex');
  } finally {
    tasks.close();
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
