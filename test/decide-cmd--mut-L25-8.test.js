'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decideCommand } = require('../commands/decide');

test('an open ask on a running mission stays in the decision list', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-cmd-mut-l25-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.exitCode = previousExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# Atris\n');
  fs.appendFileSync(
    path.join(root, '.atris', 'state', 'missions.jsonl'),
    `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-livekeep',
      objective: 'Ship the result',
      status: 'running',
      owner: 'researcher',
      created_at: '2026-07-27T08:00:00.000Z',
      updated_at: '2026-07-27T08:00:00.000Z',
      human_asks: ['Ship the result?'],
    })}\n`,
  );

  process.env.HOME = root;
  process.chdir(root);
  process.exitCode = undefined;

  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => stdout.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  try {
    decideCommand(['--json']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(stderr, []);
  assert.equal(process.exitCode, undefined);
  assert.equal(stdout.length, 1);
  assert.deepEqual(JSON.parse(stdout[0]), {
    ok: true,
    action: 'decide_list',
    count: 1,
    decisions: [
      {
        number: 1,
        owner: 'researcher',
        mission_id: 'mission-livekeep',
        mission_short_id: 'livekeep',
        mission_status: 'running',
        mission_updated_at: '2026-07-27T08:00:00.000Z',
        ask_index: 0,
        text: 'Ship the result?',
      },
    ],
  });
});
