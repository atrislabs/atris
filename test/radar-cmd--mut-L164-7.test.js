const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectRadar } = require('../commands/radar');

const AGENT_CWD = '/atris-mut/agent';

test('task workspace walk stops probing once it reaches the filesystem root', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-radar-mut-'));
  try {
    const root = path.join(sandbox, 'ws');
    fs.mkdirSync(root, { recursive: true });
    const projectionAtFsRoot = path.join(path.parse(AGENT_CWD).root, '.atris', 'state', 'tasks.projection.json');
    let rootProbes = 0;
    const data = collectRadar({
      root,
      scope: 'global',
      platform: 'linux',
      homeDir: path.join(sandbox, 'home'),
      nowMs: 0,
      execFileSync: (cmd) => (cmd === 'ps'
        ? '4242 1 5.0 0.5 Ss Wed Oct 21 10:00:00 2026 /usr/local/bin/codex exec\n'
        : ''),
      readlinkSync: () => AGENT_CWD,
      existsSync: (file) => {
        if (file === projectionAtFsRoot) rootProbes += 1;
        return false;
      },
      readFileSync: () => '',
      readdirSync: () => [],
    });
    assert.equal(data.agents.length, 1);
    assert.equal(rootProbes, 1);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
