'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { voiceCommand } = require('../commands/voice');

test('judge rejects a verdict whose pass field is not a boolean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verdict-shape-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  let stderr = '';
  try {
    process.env.HOME = dir;
    process.chdir(dir);
    fs.writeFileSync(path.join(dir, 'atris.md'), '## voice\n\nUse plain words.\n');
    voiceCommand(['judge'], {
      input: 'The reply is ready.',
      repoRoot: dir,
      env: {
        HOME: dir,
        PATH: '',
        ATRIS_VOICE_JUDGE_CMD: `printf '%s' '{"pass":"false","reasons":[]}'`,
      },
      stdout: { write() { return true; } },
      stderr: { write(chunk) { stderr += chunk; return true; } },
    });
    assert.match(stderr, /unavailable/);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
