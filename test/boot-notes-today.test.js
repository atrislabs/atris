'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function localDay(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The boot screen counts today's journal notes. It must read the local day's
// file, the one the journal writer uses, not the UTC day's file.
test('boot counts notes in the local day journal when UTC is already on another day', (t) => {
  const utcDay = new Date().toISOString().slice(0, 10);
  // At any moment one of these two zones sits on a different calendar day than UTC.
  const timeZone = localDay('Etc/GMT+12') !== utcDay ? 'Etc/GMT+12' : 'Etc/GMT-14';
  const day = localDay(timeZone);
  assert.notEqual(day, utcDay);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-boot-notes-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ws');
  const logDir = path.join(root, 'atris', 'logs', day.slice(0, 4));
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO\n', 'utf8');
  fs.writeFileSync(path.join(logDir, `${day}.md`), '# log\n\n## Inbox\n\n- **I1:** one\n- **I2:** two\n', 'utf8');

  const res = spawnSync(process.execPath, [cliPath, 'atris.md'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TZ: timeZone, CI: '1' },
    timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /logs\s+2 notes today/);
});
