'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');
function run(t, when) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-steer-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const member = path.join(root, 'atris/team/navigator');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: navigator\nrole: Test Member\n---\n# navigator\n');
  const file = path.join(root, '.atris/state/missions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { id: 'mission-existing', owner: 'navigator', objective: 'test', status: 'running', runner: 'codex' };
  fs.writeFileSync(file, `${JSON.stringify(old)}\n`);
  const preload = path.join(root, 'fault.cjs');
  fs.writeFileSync(preload, `const fs = require('fs'); const append = fs.appendFileSync; fs.appendFileSync = function(file, ...args) { if (String(file).endsWith('/.atris/state/missions.jsonl')) { if (${JSON.stringify(when)} === 'after') append.call(this, file, ...args); const e = new Error('injected ledger failure'); e.code = 'EIO'; throw e; } return append.call(this, file, ...args); };`);
  const output = spawnSync(process.execPath, ['-r', preload, cli, 'member', 'navigator', 'focus now', '--json'], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  return { output, file };
}
for (const when of ['before', 'after']) {
  test(`member steer reports unconfirmed when append throws ${when} writing`, (t) => {
    const { output, file } = run(t, when);
    assert.equal(output.status, 1, output.stderr || output.stdout);
    const payload = JSON.parse(output.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'member_steer_unconfirmed');
    assert.equal(fs.readFileSync(file, 'utf8').includes('focus now'), when === 'after');
  });
}
