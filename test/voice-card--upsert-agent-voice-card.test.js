'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAgentVoiceCard } = require('../lib/voice-card');

const BRAIN_START = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const BRAIN_END = '<!-- ATRIS_BRAIN_COMPILE:END -->';
const VOICE_START = '<!-- ATRIS_VOICE_CARD:START -->';
const VOICE_END = '<!-- ATRIS_VOICE_CARD:END -->';
const CARD = 'Start with the answer.';

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-voice-card-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('creates AGENTS.md with the brain block and voice card when the file is missing', () => {
  const file = path.join(makeTempDir(), 'AGENTS.md');
  const expected = [
    '# AGENTS',
    '',
    BRAIN_START,
    '## Atris Brain Compile',
    '',
    VOICE_START,
    '## Voice card',
    '',
    CARD,
    VOICE_END,
    BRAIN_END,
    '',
  ].join('\n');

  const result = upsertAgentVoiceCard(file, CARD);

  assert.equal(result.action, 'created');
  assert.equal(result.content, expected);
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
});

test('running again with the same card reports unchanged and keeps the file as written', () => {
  const file = path.join(makeTempDir(), 'AGENTS.md');
  const first = upsertAgentVoiceCard(file, CARD);

  const second = upsertAgentVoiceCard(file, CARD);

  assert.equal(second.action, 'unchanged');
  assert.equal(second.content, first.content);
  assert.equal(fs.readFileSync(file, 'utf8'), first.content);
});

test('replaces only the old card inside the brain block and keeps text around it', () => {
  const file = path.join(makeTempDir(), 'AGENTS.md');
  const before = [
    '# My notes',
    '',
    'keep me',
    '',
    BRAIN_START,
    '## Atris Brain Compile',
    '',
    VOICE_START,
    '## Voice card',
    '',
    'old card text',
    VOICE_END,
    BRAIN_END,
    '',
    'tail text',
  ].join('\n');
  fs.writeFileSync(file, before, 'utf8');

  const result = upsertAgentVoiceCard(file, CARD);

  assert.equal(result.action, 'updated');
  assert.equal(result.content, [
    '# My notes',
    '',
    'keep me',
    '',
    BRAIN_START,
    '## Atris Brain Compile',
    '',
    VOICE_START,
    '## Voice card',
    '',
    CARD,
    VOICE_END,
    BRAIN_END,
    '',
    'tail text',
  ].join('\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), result.content);
  assert.doesNotMatch(result.content, /old card text/);
});

test('appends the brain block below existing text when the file has no brain block', () => {
  const file = path.join(makeTempDir(), 'AGENTS.md');
  fs.writeFileSync(file, '# My agents\n\nRule one.\n', 'utf8');

  const result = upsertAgentVoiceCard(file, CARD);

  assert.equal(result.action, 'updated');
  assert.ok(
    result.content.startsWith(`# My agents\n\nRule one.\n\n${BRAIN_START}\n## Atris Brain Compile\n`),
    result.content,
  );
  assert.ok(result.content.endsWith(`${BRAIN_END}\n`), result.content);
  assert.equal(result.content.split(BRAIN_START).length - 1, 1);
});

test('dryRun returns the new content without writing a missing file or touching an existing one', () => {
  const dir = makeTempDir();
  const missing = path.join(dir, 'AGENTS.md');
  const created = upsertAgentVoiceCard(missing, CARD, { dryRun: true });

  assert.equal(created.action, 'created');
  assert.ok(created.content.includes(`${VOICE_START}\n## Voice card\n\n${CARD}\n${VOICE_END}`));
  assert.equal(fs.existsSync(missing), false);

  const existing = path.join(dir, 'CURSOR.md');
  fs.writeFileSync(existing, '# Mine\n', 'utf8');
  const updated = upsertAgentVoiceCard(existing, CARD, { dryRun: true });

  assert.equal(updated.action, 'updated');
  assert.notEqual(updated.content, '# Mine\n');
  assert.equal(fs.readFileSync(existing, 'utf8'), '# Mine\n');
});

test('throws when the target path is a directory instead of a file', () => {
  const dir = makeTempDir();

  assert.throws(() => upsertAgentVoiceCard(dir, CARD), { code: 'EISDIR' });
});
