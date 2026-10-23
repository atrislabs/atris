'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/goal');

test('setting a goal with an existing wish restores the caller working folder', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-caller-'));
  const caller = path.join(temp, 'caller');
  const project = path.join(temp, 'project');
  fs.mkdirSync(caller);
  fs.mkdirSync(path.join(project, 'atris'), { recursive: true });
  const state = path.join(project, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'wishes.jsonl'), JSON.stringify({
    id: 'wish-existing',
    text: 'ship the release',
    status: 'captured_no_mission',
    ts: '2020-01-01T12:00:00.000Z',
  }) + '\n');

  const previous = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = temp;
    process.chdir(caller);
    const expected = process.cwd();
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };

    assert.equal(run(['set', 'ship the release'], { cwd: project }), 0);
    assert.ok(output.some((line) => /wish already filed:/.test(line)),
      'the existing wish is reused without invoking an engine');
    assert.equal(process.cwd(), expected,
      'setting a goal in another project must restore the caller working folder');
  } finally {
    process.chdir(previous);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
