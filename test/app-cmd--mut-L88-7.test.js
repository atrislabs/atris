require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('subprocess scaffolding includes JWT runtime authentication', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-subprocess-auth-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalExit = process.exit;
  t.after(() => {
    process.chdir(originalCwd);
    console.log = originalLog;
    process.exit = originalExit;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });
  process.env.HOME = root;
  process.chdir(root);
  console.log = () => {};
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  fs.mkdirSync(path.join(root, 'atris'));
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# workspace\n');

  const { appCommand } = require('../commands/app');
  await appCommand('init', 'worker', '--runtime', 'subprocess');

  const document = fs.readFileSync(path.join(root, 'apps', 'worker', 'APP.md'), 'utf8');
  const authentication = document.match(/^runtime_auth:\s*(\S+)/m);
  assert.strictEqual(authentication?.[1], 'jwt');
});
