'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('session includes a task updated at the requested cutoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-xp-cutoff-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.CODEX_STATE_DB = path.join(root, 'absent.sqlite');
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# temporary workspace\n');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const cutoff = '2020-02-03T12:00:00.000Z';
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.tasks_projection.v1',
      tasks: [{
        id: 'cutoff-task',
        title: 'Prepare release',
        status: 'claimed',
        created_at: '2020-02-01T12:00:00.000Z',
        updated_at: cutoff,
      }],
    }));
    const { xpCommand } = require('../commands/xp');
    console.log = (...args) => output.push(args.join(' '));
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    await xpCommand(...[
      'session', '--workspace', root,
      '--since', '2020-02-03T00:00:00.000Z', '--until', cutoff,
      '--no-write', '--json',
    ]);
    assert.strictEqual(JSON.parse(output.join('\n')).tasks.touched_count, 1);
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
