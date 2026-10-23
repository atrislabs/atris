'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAliveTick } = require('../lib/member-alive');

test('alive derives the operate reason from the child exit status when JSON omits it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-alive-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const atrisBin = path.join(root, 'fake-atris.js');
  fs.writeFileSync(atrisBin, `
    console.log(JSON.stringify(
      process.argv[2] === 'member'
        ? { decision: 'run' }
        : { ok: true }
    ));
  `);
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  const operateScript = path.join(scripts, 'member-operate.mjs');

  for (const [status, reason] of [[0, 'operate_complete'], [1, 'operate_failed']]) {
    fs.writeFileSync(operateScript, `
      console.log(JSON.stringify({ ok: ${status === 0} }));
      process.exitCode = ${status};
    `);
    const tick = runAliveTick('demo', {
      cwd: root,
      atrisBin,
      execute: true,
      confirmed: true,
      noPrime: true,
    });
    assert.equal(tick.operate.status, status);
    assert.equal(tick.operate.reason, reason);
  }
});
