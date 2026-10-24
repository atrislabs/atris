'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveCommand } = require('../commands/drive');

test('dry run reports an accidental help mission from doctor output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-drive-output-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, 'atris'));
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1', id: 'check-artifact', slug: 'check-artifact',
      objective: '--help', owner: 'mission-lead',
      cadence: 'manual', lane: 'workspace', task_ids: [],
      status: 'planning', verifier: 'node --version',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }) + '\n');
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`Unexpected exit: ${code}`); };
    await driveCommand(['--dry-run', '--json']);
    assert.match(lines.join('\n'), /accidental_help_mission/);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
