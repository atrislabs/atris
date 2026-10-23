'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../commands/site-deploy');

test('fullstack deploy reports an unreadable git index and stops before pushing', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-index-failure-'));
  const savedHome = process.env.HOME;
  const savedCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home);
  t.after(() => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({
    scripts: { start: 'node server.js' },
  }));

  const errors = [];
  let pushed = false;
  const code = await run([home, '--fullstack', '--name', 'index-failure', '--yes'], {
    homedir: () => home,
    renderApiKey: 'test-render-key',
    loadCredentials: () => ({ token: 'test-token' }),
    log: () => {},
    error: (line) => errors.push(line),
    spawnSync: (command, args) => {
      if (command === 'git' && args[0] === 'diff') {
        return { status: 128, stdout: '', stderr: 'fatal: unable to read index file' };
      }
      if (command === 'git' && args[0] === 'push') pushed = true;
      return { status: 0, stdout: '', stderr: '' };
    },
    httpRequest: async () => { throw new Error('unexpected deployment request'); },
  });

  assert.match(errors.join('\n'), /git diff .*failed \(exit 128\)/);
  assert.match(errors.join('\n'), /unable to read index file/);
  assert.equal(code, 1);
  assert.equal(pushed, false);
});
