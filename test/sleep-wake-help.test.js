const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

// Regression: `atris sleep --help` inside a folder bound to a business used
// to resolve the slug from .atris/business.json and put that computer to sleep.
function runInBoundFolder(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-help-'));
  fs.mkdirSync(path.join(dir, '.atris'));
  fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co', name: 'Example Co' }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sleep-home-'));
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    env: { ...process.env, HOME: home, ATRIS_PROFILE: '' },
    encoding: 'utf8',
    timeout: 20000,
  });
}

for (const cmd of ['sleep', 'wake']) {
  for (const flag of ['--help', '-h', 'help']) {
    test(`atris ${cmd} ${flag} prints usage and never touches the bound business`, () => {
      const r = runInBoundFolder([cmd, flag]);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`Usage: atris ${cmd}`));
      assert.doesNotMatch(r.stdout + r.stderr, /Not logged in|is now sleeping|Waking/);
    });
  }
}
