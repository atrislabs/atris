'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the next member comes from the most recently updated completed mission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-latest-status-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const exit = process.exit;
  const lines = [];
  const halt = new Error('plan captured');
  const signals = new Map(['SIGINT', 'SIGTERM'].map(name => [name, process.listeners(name)]));
  try {
    process.env.HOME = root;
    process.chdir(root);
    const { autopilotFront } = require('../commands/autopilot-front');
    fs.mkdirSync(path.join(root, 'atris'));
    for (const name of ['login-owner', 'search-owner']) {
      const member = path.join(root, 'atris', 'team', name);
      fs.mkdirSync(member, { recursive: true });
      fs.writeFileSync(path.join(member, 'MEMBER.md'), `---\nname: ${name}\n---\n`);
    }
    const dir = path.join(root, '.atris', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'missions.jsonl'), [
      { id: 'recently-updated', owner: 'login-owner', objective: 'repair login for hours', status: 'completed', runner: 'atris2', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' },
      { id: 'recently-created', owner: 'search-owner', objective: 'repair search for hours', status: 'completed', runner: 'atris2', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-02T00:00:00Z' },
    ].map(JSON.stringify).join('\n') + '\n');
    console.log = (...args) => {
      const line = args.join(' ');
      lines.push(line);
      // Stop after the chosen member is announced, before any engine starts.
      if (/autopilot leg/.test(line)) throw halt;
    };
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    try {
      await autopilotFront(['--yes', '--once']);
    } catch (error) {
      if (error !== halt) throw error;
    }
    assert.match(lines.join('\n'), /login-owner/);
  } finally {
    for (const [name, before] of signals) {
      for (const listener of process.listeners(name)) {
        if (!before.includes(listener)) process.removeListener(name, listener);
      }
    }
    console.log = log;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
