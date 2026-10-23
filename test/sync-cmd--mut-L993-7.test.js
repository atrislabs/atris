const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('explicit yes authorizes workspace updates without an argv flag', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-explicit-yes-'));
  const saved = {
    cwd: process.cwd(), env: { ...process.env }, argv: process.argv,
    log: console.log, warn: console.warn, error: console.error, exit: process.exit,
  };
  const messages = [];
  const exitSignal = new Error('command exited');
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'sync'];
    console.log = console.warn = console.error = (...args) => messages.push(args.join(' '));
    process.exit = () => { throw exitSignal; };
    fs.mkdirSync(path.join(root, 'atris'));
    fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris.md\n\n> Drop this file anywhere. AI agent team activates.\n');
    const { syncAtrisAll } = require('../commands/sync');
    try {
      syncAtrisAll({ root, yes: true, dryRun: false, force: false });
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    assert.equal(fs.existsSync(path.join(root, 'atris', 'PERSONA.md')), true);
  } finally {
    process.chdir(saved.cwd);
    process.argv = saved.argv;
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    process.exit = saved.exit;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved.env);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
