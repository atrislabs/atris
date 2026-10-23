'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveCommand } = require('../commands/drive');

test('dry run parks a planning mission that has no verifier', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-drive-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const originalLog = console.log;
  const originalExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    const state = path.join(dir, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'missions.jsonl'), JSON.stringify({
      schema: 'atris.mission.v1',
      id: 'mission-2026-01-01-planning-review',
      owner: 'reviewer',
      objective: 'Review the pending changes',
      status: 'planning',
      verifier: '',
      stop_reason: 'waiting for a verifier',
      created_at: '2026-01-01T12:00:00.000Z',
      updated_at: '2026-01-01T12:00:00.000Z',
    }) + '\n');
    process.exit = code => { throw new Error(`unexpected exit ${code}`); };
    console.log = (...args) => lines.push(args.join(' '));
    await driveCommand(['--dry-run', '--json']);
    const result = JSON.parse(lines.join('\n'));
    assert.equal(result.fixed_detail.find(item => item.mission_id === 'mission-2026-01-01-planning-review')?.action, 'would_park');
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
