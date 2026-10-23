'use strict';

const test = require('node:test');
const assert = require('node:assert');
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

function withTempRepo(fn) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-command-'));
  try {
    return fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
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

test('scan passes plain text, fails an em dash, and reads an empty reply as a pass', () => {
  const out = capture();
  const err = capture();

  const pass = voiceCommand(['scan'], {
    input: 'The build is ready. All checks passed.',
    stdout: out.stream,
    stderr: err.stream,
  });
  assert.strictEqual(pass, 0);
  assert.strictEqual(out.text, 'PASS\n');
  assert.strictEqual(err.text, '');

  const fail = capture();
  const failCode = voiceCommand(['scan'], {
    input: 'The build is ready\u2014ship it.',
    stdout: fail.stream,
    stderr: err.stream,
  });
  assert.strictEqual(failCode, 1);
  assert.match(fail.text, /^FAIL \(1\)\n- em-dash: "U\+2014"\n$/);

  const empty = capture();
  const emptyCode = voiceCommand(['scan'], {
    input: '',
    stdout: empty.stream,
    stderr: err.stream,
  });
  assert.strictEqual(emptyCode, 0);
  assert.strictEqual(empty.text, 'PASS\n');
});

test('scan --json prints machine-readable findings for a clean and a dirty reply', () => {
  const clean = capture();
  assert.strictEqual(voiceCommand(['scan', '--json'], {
    input: 'The reply is ready.',
    stdout: clean.stream,
    stderr: capture().stream,
  }), 0);
  assert.deepStrictEqual(JSON.parse(clean.text), { pass: true, findings: [] });

  const dirty = capture();
  assert.strictEqual(voiceCommand(['scan', '--json'], {
    input: 'Shipped CLI-123 today.',
    stdout: dirty.stream,
    stderr: capture().stream,
  }), 1);
  const parsed = JSON.parse(dirty.text);
  assert.strictEqual(parsed.pass, false);
  assert.deepStrictEqual(parsed.findings, [{ rule: 'task-code', snippet: 'CLI-123' }]);
});

test('no subcommand and an unknown subcommand both exit 2 with usage on stderr', () => {
  const noArgs = capture();
  assert.strictEqual(voiceCommand([], {
    stdout: capture().stream,
    stderr: noArgs.stream,
  }), 2);
  assert.match(noArgs.text, /usage: atris voice scan \[--json\]/);

  const unknown = capture();
  const out = capture();
  assert.strictEqual(voiceCommand(['bogus'], {
    input: 'unused',
    stdout: out.stream,
    stderr: unknown.stream,
  }), 2);
  assert.strictEqual(unknown.text, 'usage: atris voice scan [--json] | atris voice judge | atris voice card [--hook]\n');
  assert.strictEqual(out.text, '');
});

test('help exits 0 and writes usage to stdout', () => {
  for (const flag of ['help', '--help', '-h']) {
    const out = capture();
    assert.strictEqual(voiceCommand([flag], {
      stdout: out.stream,
      stderr: capture().stream,
    }), 0);
    assert.match(out.text, /^usage: atris voice scan \[--json\]\n {7}atris voice judge\n/);
  }
});

test('card prints the voice card built from the repo doctrine, and --hook wraps it as JSON', () => {
  withTempRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'atris.md'), VOICE_DOC, 'utf8');
    const options = { repoRoot, stderr: capture().stream };

    const plain = capture();
    assert.strictEqual(voiceCommand(['card'], { ...options, stdout: plain.stream }), 0);
    assert.ok(plain.text.startsWith('Start with the answer. Name the exact thing in plain words'));
    assert.ok(plain.text.includes('Status example:\n'));
    assert.ok(plain.text.endsWith('the change is ready.\n'));

    const hook = capture();
    assert.strictEqual(voiceCommand(['card', '--hook'], { ...options, stdout: hook.stream }), 0);
    const payload = JSON.parse(hook.text);
    assert.strictEqual(payload.suppressOutput, true);
    assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.strictEqual(payload.hookSpecificOutput.additionalContext, plain.text.slice(0, -1));
  });
});

test('judge without a voice section fails open: exit 0, reason on stderr, nothing on stdout', () => {
  withTempRepo((repoRoot) => {
    const out = capture();
    const err = capture();
    const code = voiceCommand(['judge'], {
      input: 'The reply is ready.',
      repoRoot,
      env: { PATH: '' },
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(out.text, '');
    assert.strictEqual(err.text, 'voice judge unavailable: the voice section was not found\n');
  });
});

test('judge with no judge engine on PATH fails open the same way', () => {
  withTempRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'atris.md'), VOICE_DOC, 'utf8');
    const out = capture();
    const err = capture();
    const code = voiceCommand(['judge'], {
      input: 'The reply is ready.',
      repoRoot,
      env: { PATH: '' },
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(out.text, '');
    assert.strictEqual(err.text, 'voice judge unavailable: no judge command was found\n');
  });
});

test('judge runs a stub judge command and maps its verdict to an exit code', () => {
  withTempRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'atris.md'), VOICE_DOC, 'utf8');
    const verdict = '{"pass":false,"reasons":["opens with a preamble"]}';
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
    assert.strictEqual(code, 1);
    assert.strictEqual(err.text, '');
    assert.deepStrictEqual(JSON.parse(out.text), {
      pass: false,
      reasons: ['opens with a preamble'],
    });
  });
});

test('judge treats an unreadable stub verdict as unavailable and still exits 0', () => {
  withTempRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, 'atris.md'), VOICE_DOC, 'utf8');
    const out = capture();
    const err = capture();
    const code = voiceCommand(['judge'], {
      input: 'The reply is ready.',
      repoRoot,
      env: {
        PATH: '/usr/bin:/bin',
        ATRIS_VOICE_JUDGE_CMD: `cat >/dev/null; printf '%s' 'not json'`,
      },
      stdout: out.stream,
      stderr: err.stream,
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(out.text, '');
    assert.strictEqual(err.text, 'voice judge unavailable: the judge returned an unreadable verdict\n');
  });
});
