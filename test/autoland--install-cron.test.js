'use strict';

// installCron talks to the real `crontab` binary through spawnSync, so each
// test prepends a fake `crontab` shell script to PATH. The fake persists the
// table to a file inside the test's temp dir; the machine's real crontab is
// never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { installCron } = require('../lib/autoland');

const FAKE_CRONTAB = [
  '#!/bin/sh',
  'state="$FAKE_CRON_STATE"',
  'if [ "$1" = "-l" ]; then',
  '  if [ -f "$state" ]; then cat "$state"; fi',
  '  exit 0',
  'fi',
  'if [ "$1" = "-" ]; then',
  '  if [ -n "$FAKE_CRON_FAIL" ]; then cat > /dev/null; exit 1; fi',
  '  cat > "$state"',
  '  exit 0',
  'fi',
  'exit 2',
  '',
].join('\n');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-install-cron-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const root = path.join(base, 'my project');
  fs.mkdirSync(root, { recursive: true });

  const binDir = path.join(base, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'crontab'), FAKE_CRONTAB, { mode: 0o755 });

  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });

  const stateFile = path.join(base, 'crontab.txt');
  const saved = {};
  for (const key of ['PATH', 'HOME', 'FAKE_CRON_STATE', 'FAKE_CRON_FAIL']) {
    saved[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.PATH = `${binDir}${path.delimiter}${saved.PATH || ''}`;
  process.env.HOME = home;
  process.env.FAKE_CRON_STATE = stateFile;
  delete process.env.FAKE_CRON_FAIL;

  const readTable = () => (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '');
  return { base, root, home, readTable };
}

test('installCron writes one labeled hourly line into an empty crontab', (t) => {
  const { root, home, readTable } = fixture(t);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'atris.js'), 'console.log(process.cwd());\n');

  assert.equal(installCron(root), true);

  const table = readTable();
  const lines = table.split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^14 \* \* \* \* /);
  assert.match(lines[0], /autoland tick/);
  assert.match(lines[0], /# ATRIS_AUTOLAND_MY_PROJECT$/);
  assert.ok(lines[0].includes(`cd '${root}'`));
  assert.ok(fs.statSync(path.join(home, '.atris', 'overnight')).isDirectory());
  const run = spawnSync('/bin/sh', ['-c', lines[0].replace(/^14 \* \* \* \* /, '')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(path.join(home, '.atris', 'overnight', 'autoland-my project.log'), 'utf8'), `${fs.realpathSync(root)}\n`);
});

test('installCron keeps foreign entries and replaces its own line exactly once', (t) => {
  const { root, readTable } = fixture(t);
  const marker = 'ATRIS_AUTOLAND_MY_PROJECT';

  fs.writeFileSync(
    process.env.FAKE_CRON_STATE,
    `0 5 * * * /usr/bin/other-job\n9 9 * * * stale old line # ${marker}\n`,
  );

  assert.equal(installCron(root), true);
  assert.equal(installCron(root), true);

  const table = readTable();
  assert.equal(table.split('\n').filter((line) => line.includes(marker)).length, 1);
  assert.match(table, /0 5 \* \* \* \/usr\/bin\/other-job\n/);
  assert.equal(table.includes('stale old line'), false);
});

test('installCron returns false when the crontab apply fails', (t) => {
  const { root, readTable } = fixture(t);
  process.env.FAKE_CRON_FAIL = '1';

  assert.equal(installCron(root), false);
  assert.equal(readTable(), '');
});
