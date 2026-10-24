'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('presence reads claimed tasks from the supplied filesystem', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-presence-fs-'));
  const root = path.join(home, 'project');
  const storage = path.join(home, 'storage');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(storage, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(storage, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({ tasks: [{
    id: 'task-repair', display_id: 'CLI-1300', title: 'repair saved state',
    status: 'claimed', claimed_by: 'builder', updated_at: '2026-08-16T00:43:00.000Z',
  }] }));
  const suppliedFs = { ...fs };
  for (const method of ['existsSync', 'readFileSync', 'readdirSync', 'statSync']) {
    suppliedFs[method] = (file, ...args) => fs[method](
      typeof file === 'string' && (file === root || file.startsWith(root + path.sep))
        ? storage + file.slice(root.length) : file, ...args);
  }
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const oldExit = process.exit;
  const oldLog = console.log;
  let output = '';
  process.env.HOME = home;
  process.chdir(root);
  process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
  console.log = (value) => { output += String(value); };
  try {
    whoCommand(['--json'], {
      root, fs: suppliedFs, processes: [],
      now: () => Date.parse('2026-08-16T00:45:00.000Z'),
      write: (text) => { output += text; },
    });
    assert.strictEqual(JSON.parse(output).waiting.some((row) => row.member === 'builder'), true);
  } finally {
    console.log = oldLog;
    process.exit = oldExit;
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
