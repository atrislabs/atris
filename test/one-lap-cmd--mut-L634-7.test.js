'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('new intake preserves the reviewer saved on a request needing input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lap-intake-'));
  const env = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    const { runOneLap } = require('../commands/one-lap');
    const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');
    readEngineRegistry(root);
    setEngineHealth('codex', 'ready', root);
    console.log = (...parts) => output.push(parts.join(' '));
    await runOneLap('fix the parser', {
      root, asJson: true, engine: 'codex',
      ownCli() {
        const { appendWishRecord } = require('../lib/wish-store');
        appendWishRecord(root, { id: 'wish-intake', text: 'fix the parser', ts: '2020-01-01T00:00:00Z', status: 'builder', mode: 'builder', engine: null, validator: 'claude', questions: [] });
        appendWishRecord(root, { id: 'wish-intake', text: 'fix the parser', ts: '2020-01-02T00:00:00Z', status: 'needs_input', questions: ['Which input format?'] });
        return { status: 0, stdout: JSON.stringify({ wish_id: 'wish-intake', status: 'needs_input', questions: ['Which input format?'] }), stderr: '' };
      },
      progress() {},
    });
    assert.equal(JSON.parse(output.join('\n')).validator, 'claude');
  } finally {
    console.log = log;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
