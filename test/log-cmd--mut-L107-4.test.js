const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('logAtris reports that a terminal is needed when piped input has no notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-empty-pipe-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    // Use a real closed stdin pipe, and a fixed local day in every time zone.
    const result = spawnSync(process.execPath, ['-e', `
      const { logAtris } = require('../commands/log');
      const RealDate = Date;
      global.Date = class extends RealDate {
        constructor(...args) {
          if (args.length) super(...args);
          else super(2032, 5, 15, 12, 0, 0);
        }
      };
      process.chdir(process.argv[1]);
      process.argv = [process.execPath, 'atris', 'log', '--json'];
      logAtris();
    `, root], {
      cwd: __dirname,
      env: { HOME: root },
      input: '  \n\t\r\n ExIt \n',
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({
      ok: false,
      error: 'Daily log REPL needs a terminal (2032-06-15).',
      journal: 'atris/logs/2032/2032-06-15.md',
      next_command: 'atris log "note"',
    }, null, 2) + '\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
