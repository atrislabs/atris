'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../commands/drive');
const runCommand = mod[Object.keys(mod)[0]];

test('stale ready receipt in dry-run reports would_verify_tick', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-test-'));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = tmpDir;
  process.chdir(tmpDir);

  const lines = [];
  const origLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));

  try {
    const stateDir = path.join(tmpDir, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'missions.jsonl'),
      JSON.stringify({
        id: 'mission-1',
        status: 'ready',
        verifier: 'echo ok',
        objective: 'verify step',
        owner: 'agent',
      }) + '\n',
    );

    await runCommand(['--dry-run', '--json']);
    const payload = JSON.parse(lines.join('\n'));
    assert.strictEqual(payload.fixed, 1);
    assert.strictEqual(payload.fixed_detail[0]?.action, 'would_verify_tick');
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
