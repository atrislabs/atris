'use strict';

// The hourly line `atris autoland on` writes must run under cron.
//
// One project's line said a bare `atris`. Cron's PATH is only /usr/bin:/bin,
// so from 2026-10-27 every hourly pass printed "atris: command not found",
// and the five finished jobs there were never checked or landed. This runs
// the written line the way cron does: no login shell, the short PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const autoland = require('../lib/autoland');

test('a project without its own copy of the cli gets a line cron can run', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cron-line-')));
  try {
    const project = path.join(base, 'notes project');
    fs.mkdirSync(project);
    const line = autoland.buildCronLine(project);
    assert.match(line, /^14 \* \* \* \* /);
    const command = line.replace(/^14 \* \* \* \* /, '').replace(/ autoland tick >> .*$/, ' --version');
    const res = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      timeout: 60000,
      env: { PATH: '/usr/bin:/bin', HOME: base, SHELL: '/bin/sh', ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    assert.equal(res.status, 0, `cron could not run the line: ${res.stderr || res.stdout}`);
    assert.match(res.stdout, /\d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
