'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('one lap passes the package fast-test script as the intake verifier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-lap-package-verifier-'));
  const savedEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(root, 'machine-roster.json');
    process.env.ATRIS_MACHINE_ROSTER_MD_PATH = path.join(root, 'machine-roster.md');
    process.env.ATRIS_CODEX_CONFIG_PATH = path.join(root, 'codex-config.toml');
    const { runOneLap } = require('../commands/one-lap');
    const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
    readEngineRegistry(root);
    setEngineHealth('codex', 'ready', root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: { 'test:fast': 'node --test' },
    }));
    const calls = [];
    const exit = await runOneLap('fix parser', {
      root,
      engine: 'codex',
      quiet: true,
      progress() {},
      ownCli(args) {
        calls.push(args);
        return {
          status: 0,
          stdout: JSON.stringify({
            wish_id: 'wish-fixture', status: 'needs_input', questions: ['Which parser?'],
          }),
        };
      },
    });
    assert.equal(exit, 0);
    assert.deepEqual(calls, [[
      'wish', 'fix parser', '--engine', 'codex',
      '--verify', 'npm run test:fast', '--one-lap', '--json',
    ]]);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
