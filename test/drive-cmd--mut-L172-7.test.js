'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveCommand } = require('../commands/drive');

test('dry run parks an old planning mission identified by its saved date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-drive-paused-'));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = dir;
    process.env.ATRIS_SKIP_UPDATE_CHECK = '1';
    process.env.ATRIS_OFFLINE = '1';
    fs.mkdirSync(path.join(dir, 'atris'));
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      id: 'mission-2020-01-01-saved',
      slug: 'mission-2020-01-01-saved',
      objective: 'resume saved work',
      status: 'planning',
      verifier: '',
    }) + '\n');
    process.chdir(dir);
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    await driveCommand(['--dry-run', '--json']);
    const result = JSON.parse(lines.join('\n'));
    const parked = result.fixed_detail.find((item) => item.mission_id === 'mission-2020-01-01-saved');
    assert.equal(parked && parked.action, 'would_park');
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
});
