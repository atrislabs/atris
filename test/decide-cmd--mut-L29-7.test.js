'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideCommand } = require('../commands/decide');

test('missions touched at the same time list decisions in ascending id order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-decide-id-order-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# Atris\n');
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    // Keep insertion order opposite to the required tie-breaking order.
    const missions = ['b', 'a'].map((id) => ({
      schema: 'atris.mission.v1',
      id,
      owner: 'reviewer',
      objective: 'Review a choice',
      status: 'running',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-02T00:00:00.000Z',
      human_asks: [`Approve ${id}?`],
    }));
    fs.writeFileSync(path.join(root, '.atris', 'state', 'missions.jsonl'),
      missions.map((mission) => JSON.stringify(mission)).join('\n') + '\n');
    process.chdir(root);
    console.log = (...parts) => output.push(parts.join(' '));

    decideCommand([]);

    assert.deepEqual(output, [
      '[1] reviewer · a · Approve a?',
      '[2] reviewer · b · Approve b?',
      'atris decide <n> y|n',
    ]);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
