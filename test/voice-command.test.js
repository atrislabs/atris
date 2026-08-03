'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { extractVoiceSection } = require('../commands/voice');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'atris.js');

function runVoice(args, input, env = {}, unset = []) {
  const childEnv = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ...env };
  for (const name of unset) delete childEnv[name];
  return spawnSync(process.execPath, [CLI, 'voice', ...args], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: childEnv,
  });
}

test('scan mode passes clean stdin and fails sloppy stdin through the CLI', () => {
  const clean = runVoice(['scan'], 'The reply is ready. It tells the reader what changed.');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), 'PASS');

  const sloppy = runVoice(['scan'], 'The verifier\u2014for CLI-123 is ready.');
  assert.equal(sloppy.status, 1, sloppy.stderr);
  assert.match(sloppy.stdout, /^FAIL/);
  assert.match(sloppy.stdout, /em-dash/);
  assert.match(sloppy.stdout, /task-code/);

  const json = runVoice(['scan', '--json'], 'The reply is ready.');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { pass: true, findings: [] });
});

test('judge fails open when no judge engine is configured', () => {
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-path-'));
  try {
    const result = runVoice(
      ['judge'],
      'The reply is ready.',
      { PATH: emptyPath },
      ['ATRIS_VOICE_JUDGE_CMD'],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^voice judge unavailable: .+\n$/);
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});

test('judge honors ATRIS_VOICE_JUDGE_CMD and rejects a clean failing verdict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-stub-'));
  const stub = path.join(dir, 'judge.sh');
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    'test -f "$ATRIS_VOICE_RUBRIC" || exit 2',
    '/bin/cat >/dev/null',
    'printf \'%s\\n\' \'{"pass":false,"reasons":["test"]}\'',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(stub, 0o755);
  try {
    const result = runVoice(['judge'], 'This reply should be judged.', {
      ATRIS_VOICE_JUDGE_CMD: stub,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { pass: false, reasons: ['test'] });
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rubric extraction returns only the voice section text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-rubric-'));
  try {
    fs.writeFileSync(path.join(dir, 'atris.md'), [
      '# Atris',
      '',
      '## voice',
      '',
      'Use plain words.',
      '',
      '## tasks',
      '',
      'Do the work.',
      '',
    ].join('\n'), 'utf8');
    assert.equal(extractVoiceSection(dir), '## voice\n\nUse plain words.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rubric extraction falls back to atris/atris.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-rubric-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'));
    fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '## voice\n\nUse the fallback.\n', 'utf8');
    assert.equal(extractVoiceSection(dir), '## voice\n\nUse the fallback.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
