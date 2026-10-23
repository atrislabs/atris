'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const experiments = path.join(__dirname, '..', 'commands', 'experiments.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
const FAKE_CLOCK = "const FIXED = Date.parse('2026-10-23T05:30:00Z'); const R = Date;"
  + ' global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };';

test('an experiment run is recorded on the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-experiments-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, 'atris', 'experiments', 'evening-pack');
  fs.mkdirSync(pack, { recursive: true });
  // The loop runs under node here, so the test needs no Python.
  fs.writeFileSync(path.join(pack, 'loop.py'), '// noop\n', 'utf8');
  const code = `${FAKE_CLOCK} const { experimentsCommand } = require(${JSON.stringify(experiments)});`
    + " Promise.resolve(experimentsCommand('run', 'evening-pack')).catch((e) => { console.error(e); process.exit(1); });";
  const res = spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles', ATRIS_EXPERIMENTS_PYTHON: process.execPath },
  });
  assert.equal(res.status, 0, res.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'experiments-daily.json'), 'utf8'));
  assert.equal(state.last_run_date, '2026-10-22');
  assert.deepEqual(state.history, ['evening-pack']);
});
