'use strict';

// A brand new project's member and task views say only what is true there:
// setup's own notes are not work, and runs in other projects are not this
// team working. Each test builds a real fresh project with `atris init`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { teamCommand } = require('../commands/team');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function freshProject(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fresh-truth-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const env = {
    ...process.env,
    HOME: path.join(base, 'home'),
    ATRIS_TASKS_DB: path.join(base, 'tasks.db'),
    CI: 'true',
  };
  fs.mkdirSync(env.HOME);
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(run('git', ['init', '-q']).status, 0);
  const init = run(process.execPath, [CLI, 'init', '--yes']);
  assert.equal(init.status, 0, init.stderr);
  return { root, env, run };
}

test('a fresh project shows no member work this week, because setup is not a run', (t) => {
  const { root, run } = freshProject(t);
  const seeded = fs.readdirSync(path.join(root, 'atris', 'team'))
    .filter((name) => fs.existsSync(path.join(root, 'atris', 'team', name, 'logs')));
  assert.ok(seeded.length > 0, 'init writes a starter log for its members');
  const team = run(process.execPath, [CLI, 'team', '--json']);
  assert.equal(team.status, 0, team.stderr);
  const rows = JSON.parse(team.stdout).filter((row) => seeded.includes(row.name));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.doesNotMatch(row.doing, /run(s)? this week/, `${row.name}: ${row.doing}`);
    assert.notEqual(row.state, 'this week', `${row.name} never ran`);
    assert.equal(row.activity && row.activity.runs_7d, 0, `${row.name} has no runs`);
  }
});

test('real work written to a member log still counts on a fresh project', (t) => {
  const { root, run } = freshProject(t);
  const logs = path.join(root, 'atris', 'team', 'navigator', 'logs');
  const [day] = fs.readdirSync(logs).filter((name) => name.endsWith('.md'));
  fs.appendFileSync(path.join(logs, day), '\n## 09:00 · Task claimed\n- task: find the map\n');
  const team = run(process.execPath, [CLI, 'team', '--json']);
  assert.equal(team.status, 0, team.stderr);
  const navigator = JSON.parse(team.stdout).find((row) => row.name === 'navigator');
  assert.equal(navigator.doing, '1 run this week');
});

test('the team view leaves out live runs working in other projects', (t) => {
  const { root } = freshProject(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-other-project-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const prompt = (member, goal) => `claude -p "acting as ${member}. ${goal}"`;
  const ps = [
    `  101     1   01:00 ${prompt('executor', 'Ship the other project')}`,
    `  102     1   02:00 ${prompt('navigator', 'Map this project')}`,
  ].join('\n');
  let out = '';
  const code = teamCommand(['--json'], {
    cwd: root,
    root,
    runPs: () => ({ status: 0, stdout: `  PID  PPID  ELAPSED COMMAND\n${ps}\n` }),
    runFolders: () => new Map([[101, elsewhere], [102, path.join(root, 'atris')]]),
    write: (text) => { out += text; },
  });
  assert.equal(code, 0);
  const rows = JSON.parse(out);
  const working = rows.filter((row) => row.state === 'working now').map((row) => row.name);
  assert.deepEqual(working, ['navigator']);
  assert.equal(rows.find((row) => row.name === 'executor').live_runs.length, 0);
});
