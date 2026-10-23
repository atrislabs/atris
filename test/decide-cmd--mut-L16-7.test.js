'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideCommand } = require('../commands/decide');

test('decision JSON reports the update timestamp rather than the creation timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-updated-at-'));
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), '{}\n');
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'ask-one',
      owner: 'tester',
      status: 'running',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-02-01T00:00:00.000Z',
      human_asks: ['Proceed?'],
    }) + '\n');

    console.log = (...parts) => output.push(parts.join(' '));
    decideCommand(['--json']);

    assert.equal(output.length, 1);
    assert.deepStrictEqual(JSON.parse(output[0]), {
      ok: true,
      action: 'decide_list',
      count: 1,
      decisions: [{
        number: 1,
        owner: 'tester',
        mission_id: 'ask-one',
        mission_short_id: 'ask-one',
        mission_status: 'running',
        mission_updated_at: '2020-02-01T00:00:00.000Z',
        ask_index: 0,
        text: 'Proceed?',
      }],
    });
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
