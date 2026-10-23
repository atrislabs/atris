'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { voiceCommand } = require('../commands/voice');

function capture() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += chunk;
        return true;
      },
    },
    get text() {
      return text;
    },
  };
}

const VOICE_DOC = [
  '# Doctrine',
  '',
  '## voice',
  '',
  '- **Lead with the move.** Start with the answer.',
  '',
  '## next',
  '',
].join('\n');

test('a verdict carrying an extra key is rejected as unreadable', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-mut-'));
  try {
    fs.writeFileSync(path.join(repoRoot, 'atris.md'), VOICE_DOC, 'utf8');
    const verdict = '{"pass":false,"reasons":["opens with a preamble"],"zeta":"extra"}';
    const out = capture();
    const err = capture();
    const code = voiceCommand(['judge'], {
      input: 'Sure, here is the reply you asked for.',
      repoRoot,
      env: {
        PATH: '/usr/bin:/bin',
        ATRIS_VOICE_JUDGE_CMD: `cat >/dev/null; printf '%s' '${verdict}'`,
      },
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.equal(code, 0);
    assert.match(err.text, /unreadable verdict/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
