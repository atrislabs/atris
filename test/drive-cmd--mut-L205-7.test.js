'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveCommand } = require('../commands/drive');

test('drive counts repeated disengagement reasons', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-drive-reasons-'));
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
    const records = ['first', 'second'].map(id => ({
      schema: 'atris.mission.v1', id, slug: id,
      objective: `Check ${id} artifact`, owner: 'mission-lead',
      cadence: 'manual', lane: 'workspace', task_ids: [],
      status: 'planning', verifier: '',
      created_at: '2026-06-30T00:00:00.000Z',
      updated_at: '2026-06-30T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(state, 'missions.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    console.log = (...args) => lines.push(args.join(' '));
    process.exit = code => { throw new Error(`Unexpected exit: ${code}`); };
    await driveCommand(['--dry-run']);
    assert.match(lines.join('\n'), /missing_verifier\s+×2\b/);
  } finally {
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
