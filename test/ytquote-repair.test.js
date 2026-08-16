'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'det', 'ytquote-repair.js');

const TRANSCRIPT = [
  '[00:00]',
  'The ocean is a desert with its life underground',
  '[00:30]',
  'And a perfect disguise above the waves',
  '[01:00]',
  'The city is a forest of steel and glass towers',
  '[01:30]',
  'People walk quickly through the morning rain',
  '[02:00]',
  'Speed is the only moat that compounds without a meeting',
  '[02:30]',
  'Proof beats a longer argument every single time',
  '',
].join('\n');

const NOTES = [
  '# Speed notes',
  'Channel · 3:00',
  '',
  '**Hook one.**',
  'A beat about water.',
  '',
  '> "The ocean is a desert with its life underground" [00:00]',
  '',
  '**Hook two.**',
  'A beat about shipping.',
  '',
  '> "Haste is the only moat that compounds without a meeting" [02:00]',
  '',
  '**Hook three.**',
  'A beat about fiction.',
  '',
  '> "Unicorns invented quantum breakfast in the basement laboratory yesterday" [00:30]',
  '',
  '**Takeaway**',
  '',
  '1. Keep quotes honest.',
  '2. Drop the rest.',
  '',
].join('\n');

test('ytquote-repair keeps exact quotes, repairs paraphrases, drops fabrications', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytquote-repair-'));
  const notesPath = path.join(dir, 'notes.md');
  const transcriptPath = path.join(dir, 'clean.txt');
  fs.writeFileSync(notesPath, NOTES);
  fs.writeFileSync(transcriptPath, TRANSCRIPT);

  const result = spawnSync(process.execPath, [SCRIPT, notesPath, transcriptPath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), 'quotes: 1 kept, 1 repaired, 1 dropped');

  const repaired = fs.readFileSync(notesPath, 'utf8');
  assert.match(repaired, /> "The ocean is a desert with its life underground" \[00:00\]/);
  assert.match(repaired, /> "Speed is the only moat that compounds without a meeting" \[02:00\]/);
  assert.doesNotMatch(repaired, /Haste is the only moat/);
  assert.doesNotMatch(repaired, /Unicorns invented quantum breakfast/);
  assert.match(repaired, /# Speed notes/);
  assert.match(repaired, /\*\*Takeaway\*\*/);

  fs.rmSync(dir, { recursive: true, force: true });
});
