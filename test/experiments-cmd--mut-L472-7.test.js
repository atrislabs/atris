require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('benchmark passes the supplied runner context to the task runner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-context-'));
  const previousBackend = process.env.ATRIS_BACKEND_ROOT;
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousExit = process.exit;
  process.env.HOME = root;
  process.env.ATRIS_BACKEND_ROOT = root;
  try {
    const autopilot = require('../commands/autopilot');
    let options;
    t.mock.method(autopilot, 'runTaskOnce', (...args) => { options = args; throw new Error('captured runner'); });
    const { experimentsCommand } = require('../commands/experiments');
    const repo = path.join(__dirname, '..');
    for (const relative of ['atris/features/endstate', 'atris/experiments/endstate-baseline']) {
      fs.cpSync(path.join(repo, relative), path.join(root, relative), { recursive: true });
    }
    const pack = path.join(root, 'atris/experiments/endstate-baseline');
    fs.rmSync(path.join(pack, 'artifacts'), { recursive: true, force: true });
    const profilePath = path.join(pack, 'runner.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.context_note = 'Inspect the payment rounding boundary before planning.';
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    process.chdir(root);
    console.log = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    try { experimentsCommand('run', 'endstate-baseline'); } catch (error) {
      if (!error.message.startsWith('unexpected exit')) throw error;
    }
    assert.ok(options[1].contextNote.includes(profile.context_note));
  } finally {
    process.chdir(previousCwd);
    console.log = previousLog;
    process.exit = previousExit;
    if (previousBackend === undefined) delete process.env.ATRIS_BACKEND_ROOT;
    else process.env.ATRIS_BACKEND_ROOT = previousBackend;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
