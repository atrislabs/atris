'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOrb } = require('../commands/orb');

test('orb pick 1 prints the first displayed move and its prompt', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orb-pick-index-')));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const previousLog = console.log;
  const previousError = console.error;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.PATH = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris.md'), '# atris\n');
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        { display_id: 'TEST-1', title: 'Check the first proof', status: 'review' },
        { display_id: 'TEST-2', title: 'Repair the failed build', status: 'failed' },
        { display_id: 'TEST-3', title: 'Clear the blocked queue', status: 'blocked' },
      ],
    }));
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {}; // A missing engine is expected; one-shot picks never launch it.

    const code = await runOrb(['--pick', '1']);
    assert.deepEqual(output.slice(-3), [
      'picked 1: review: Check the first proof',
      'next: atris orb --pick 1',
      'prompt: Task TEST-1 ("Check the first proof") is waiting in review. Read its proof and diff, then tell me plainly: accept, or what exactly to fix.',
    ]);
    assert.equal(code, 0);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
