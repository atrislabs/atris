'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertOutboundSendAllowedOrExit,
  extractOutboundGateOptions,
  prepareOutboundSendTextOrExit,
} = require('../lib/outbound-send-gate');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-send-gate-lib-'));
}

test('extractOutboundGateOptions keeps the message and reads the send flags', () => {
  const dir = makeTempDir();
  try {
    const bodyFile = path.join(dir, 'body.txt');
    const proofFile = path.join(dir, 'proof.txt');
    fs.writeFileSync(bodyFile, 'shipped the note\n');
    fs.writeFileSync(proofFile, 'preview saved\n');

    const parsed = extractOutboundGateOptions([
      'shipped',
      'the',
      'note',
      '--visual',
      '--allow-slop=yes',
      '--format',
      'HTML',
      '--render-proof',
      proofFile,
      '--body-file',
      bodyFile,
    ]);

    assert.deepEqual(parsed.args, ['shipped', 'the', 'note']);
    assert.equal(parsed.gate.format, 'html');
    assert.equal(parsed.gate.visual, true);
    assert.equal(parsed.gate.allowSlop, true);
    assert.equal(parsed.gate.proofFile, path.resolve(proofFile));
    assert.equal(parsed.gate.bodyFile, path.resolve(bodyFile));

    const equalsForm = extractOutboundGateOptions([
      '--format=markdown',
      `--proof-file=${proofFile}`,
      `--body-file=${bodyFile}`,
      'left',
      'over',
    ]);
    assert.deepEqual(equalsForm.args, ['left', 'over']);
    assert.equal(equalsForm.gate.format, 'markdown');
    assert.equal(equalsForm.gate.visual, false);
    assert.equal(equalsForm.gate.allowSlop, false);
    assert.equal(equalsForm.gate.proofFile, path.resolve(proofFile));
    assert.equal(equalsForm.gate.bodyFile, path.resolve(bodyFile));

    const eaten = extractOutboundGateOptions(['--format', '--visual', 'hello']);
    assert.equal(eaten.gate.format, '--visual');
    assert.equal(eaten.gate.visual, false);
    assert.deepEqual(eaten.args, ['hello']);

    const emptyProof = extractOutboundGateOptions(['--proof-file=']);
    assert.equal(emptyProof.gate.proofFile, null);
    assert.deepEqual(emptyProof.args, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plain text skips the gate and an html body file with proof is inspected', () => {
  const dir = makeTempDir();
  try {
    const skipped = prepareOutboundSendTextOrExit('Slack', ['shipped', 'the', 'note']);
    assert.deepEqual(skipped, {
      ok: true,
      inspected: false,
      body: 'shipped the note',
      file: null,
    });

    const empty = assertOutboundSendAllowedOrExit('email', '   ');
    assert.equal(empty.ok, true);
    assert.equal(empty.inspected, false);
    assert.equal(empty.body, '   ');
    assert.equal(empty.file, null);

    const bodyFile = path.join(dir, 'note.md');
    fs.writeFileSync(bodyFile, '<p>shipped the note and we leverage the list</p>\n');
    const proofFile = path.join(dir, 'preview.txt');
    fs.writeFileSync(proofFile, 'preview saved\n');

    const inspected = prepareOutboundSendTextOrExit('Email', [
      'this positional text is dropped',
      '--format',
      'HTML',
      '--allow-slop',
      '--body-file',
      bodyFile,
      '--proof-file',
      proofFile,
    ]);

    assert.equal(inspected.ok, true);
    assert.equal(inspected.inspected, true);
    assert.equal(inspected.body, '<p>shipped the note and we leverage the list</p>\n');
    assert.equal(inspected.file, path.resolve(bodyFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plain html in a body file is refused before the send', () => {
  const dir = makeTempDir();
  const bodyFile = path.join(dir, 'note.txt');
  fs.writeFileSync(bodyFile, '<p>shipped the note</p>\n');
  const seen = [];
  const originalError = console.error;
  const originalExit = process.exit;
  console.error = (line) => {
    seen.push(String(line));
  };
  process.exit = (code) => {
    const error = new Error(`exit ${code}`);
    error.code = code;
    throw error;
  };

  try {
    let thrown = null;
    try {
      assertOutboundSendAllowedOrExit('Slack', 'ignored because the body file wins', {
        format: 'plain',
        bodyFile,
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.equal(thrown.code, 1);
    assert.deepEqual(seen, [
      `outbound artifact gate failed: raw-html-in-plain-body in ${path.resolve(bodyFile)}`,
    ]);
  } finally {
    console.error = originalError;
    process.exit = originalExit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
