const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initAtris } = require('../commands/init');

test('initialization preserves a customized persona', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-persona-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const argv = process.argv;
  const log = console.log;
  const exit = process.exit;
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    process.argv = [process.execPath, 'atris', 'init', '--yes', '--minimal'];
    console.log = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    fs.mkdirSync(path.join(dir, 'atris'));
    const persona = path.join(dir, 'atris', 'PERSONA.md');
    fs.writeFileSync(persona, '# Persona\n\nUse short sentences for our studio.\n');
    await initAtris(['--yes', '--minimal']);
    assert.match(fs.readFileSync(persona, 'utf8'), /Use short sentences for our studio\./);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    process.argv = argv;
    console.log = log;
    process.exit = exit;
  }
});
