'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { voiceCommand } = require('../commands/voice');

test('judge rejects a verdict whose reasons contain a non-string', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-invalid-reasons-'));
  fs.writeFileSync(path.join(dir, 'atris.md'), '## voice\n\nUse plain words.\n');
  let diagnostic = '';
  voiceCommand(['judge'], {
    repoRoot: dir,
    input: 'The reply is ready.',
    env: {
      HOME: dir,
      ATRIS_VOICE_JUDGE_CMD: `printf '%s' '{"pass":false,"reasons":[42]}'`,
    },
    stdout: { write() { return true; } },
    stderr: { write(chunk) { diagnostic += chunk; return true; } },
  });
  assert.match(diagnostic, /unreadable verdict/);
});
