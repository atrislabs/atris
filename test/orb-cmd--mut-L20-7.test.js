'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOrb } = require('../commands/orb');

const picked = [
  'picked 1: review: Audit orb command flow',
  'next: atris orb --pick 1',
  'prompt: Task CLI-100 ("Audit orb command flow") is waiting in review. Read its proof and diff, then tell me plainly: accept, or what exactly to fix.',
].join('\n');

test('picking a review move keeps the collapsed label', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orb-cmd-mut-L20-7-')));
  const savedCwd = process.cwd();
  const savedHome = process.env.HOME;
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;

  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris.md'), '# atris\n');
  fs.writeFileSync(
    path.join(root, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({
      schema: 'atris.task_projection.v1',
      tasks: [
        {
          display_id: 'CLI-100',
          title: 'Audit   orb\tcommand   flow',
          status: 'review',
        },
      ],
    }),
  );

  process.chdir(root);
  process.env.HOME = root;
  console.log = (...parts) => {
    logs.push(parts.map((part) => String(part)).join(' '));
  };
  console.error = () => {};

  try {
    const code = await runOrb(['--pick', '1', '--once']);
    const text = logs.join('\n');
    assert.equal(code, 0);
    assert.equal(text.slice(-picked.length), picked);
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
