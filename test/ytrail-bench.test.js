'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseQuoteRepair,
  parseWriter,
  parseMinWords,
  gradeRun,
  formatLine,
  outDir,
} = require('../scripts/det/ytrail-eval');
const {
  CASES,
  parseArgs,
  selectCases,
  findBinary,
  judgeNoCaptions,
  judgeNoDownloader,
  judgeNoWriter,
  summary,
} = require('../scripts/det/ytrail-bench');
const { parseEvalLine } = require('../scripts/det/ytrail-race');
const { runYoutubeBench } = require('../commands/youtube');

const STDERR = [
  'Gemini did not answer; writing the notes with Haiku instead.',
  'notes by Haiku',
  'quotes: 4 kept, 1 repaired, 2 dropped',
].join('\n');

test('parseQuoteRepair reads the quote tally line', () => {
  assert.deepEqual(parseQuoteRepair(STDERR), { kept: 4, repaired: 1, dropped: 2 });
  assert.equal(parseQuoteRepair('nothing here'), null);
  assert.equal(parseQuoteRepair(undefined), null);
});

test('parseWriter reads the writer that wrote the notes', () => {
  assert.equal(parseWriter(STDERR), 'Haiku');
  assert.equal(parseWriter('notes by Gemini\n'), 'Gemini');
  assert.equal(parseWriter('No AI writer is installed on this computer.'), null);
});

test('parseMinWords falls back to 1000 on junk', () => {
  assert.equal(parseMinWords('50'), 50);
  assert.equal(parseMinWords(undefined), 1000);
  assert.equal(parseMinWords('lots'), 1000);
  assert.equal(parseMinWords('-3'), 1000);
});

test('outDir follows YTRAIL_OUT_DIR', () => {
  assert.equal(outDir({ YTRAIL_OUT_DIR: '/x/y' }), '/x/y');
  assert.match(outDir({}), /atris[/\\]benchmarks$/);
});

const TRANSCRIPT = 'the quick brown fox jumps over the lazy dog every single morning at dawn';
const NOTES = '# Fox\n\n> "the quick brown fox jumps over the lazy dog" [00:01]\n> "every single morning at dawn" [00:04]\n';

test('gradeRun passes honest notes over enough words', () => {
  const grade = gradeRun({ status: 0, notes: NOTES, transcript: TRANSCRIPT, minWords: 10 });
  assert.equal(grade.pass, true);
  assert.equal(grade.words, 14);
  assert.equal(grade.quoteScore.verified, 2);
});

test('gradeRun fails a short transcript, a bad exit, or made-up quotes', () => {
  assert.equal(gradeRun({ status: 0, notes: NOTES, transcript: TRANSCRIPT }).checks.transcriptWords, false);
  assert.equal(gradeRun({ status: 3, notes: NOTES, transcript: TRANSCRIPT, minWords: 10 }).pass, false);
  const invented = '# Fox\n\n"a sentence nobody ever said out loud"\n"another sentence nobody ever said"\n';
  assert.equal(gradeRun({ status: 0, notes: invented, transcript: TRANSCRIPT, minWords: 10 }).checks.quoteHonesty, false);
});

test('formatLine keeps the line ytrail-race.js parses', () => {
  const grade = gradeRun({ status: 0, notes: NOTES, transcript: TRANSCRIPT, minWords: 10 });
  const row = { pass: true, engine: 'auto', seconds: 12.5, writer: 'Gemini', exit: 0 };
  const line = formatLine(row, grade);
  assert.match(line, /^ytrail pass auto 12\.5s words=14 quotes=2\/2 heading=yes writer=Gemini exit=0$/);
  assert.deepEqual(parseEvalLine(line), {
    engine: 'auto', seconds: 12.5, pass: true, quotesVerified: 2, quotesTotal: 2,
  });
});

test('bench flags pick the cases', () => {
  const names = (opts) => selectCases(opts).map((c) => c.name);
  assert.deepEqual(names(parseArgs([])), CASES.map((c) => c.name));
  assert.deepEqual(names(parseArgs(['--quick'])), ['captioned-short', 'stranger-no-downloader', 'stranger-no-writer']);
  assert.deepEqual(names(parseArgs(['--case', 'no-captions'])), ['no-captions']);
  assert.deepEqual(names(parseArgs(['--case=captioned-long'])), ['captioned-long']);
  assert.throws(() => selectCases(parseArgs(['--case', 'nope'])), /unknown case: nope/);
  assert.throws(() => parseArgs(['--fast']), /unknown option/);
});

test('no-captions passes on the grade when a speech model is installed', () => {
  assert.deepEqual(
    judgeNoCaptions({ whisper: '/bin/mlx_whisper', row: { pass: true, exit: 0 }, stderr: '' }),
    { pass: true, note: 'local transcription' },
  );
  assert.equal(judgeNoCaptions({ whisper: '/bin/mlx_whisper', row: { pass: false, exit: 0 }, stderr: '' }).pass, false);
});

test('no-captions without a speech model passes only on exit 2 with the paid command', () => {
  const paid = 'No English captions found.\nPaid notes, 5 credits, refunded if it fails: atris youtube process "u"';
  assert.equal(judgeNoCaptions({ whisper: null, row: { pass: false, exit: 2 }, stderr: paid }).pass, true);
  assert.equal(judgeNoCaptions({ whisper: null, row: { pass: false, exit: 3 }, stderr: paid }).pass, false);
  assert.equal(judgeNoCaptions({ whisper: null, row: { pass: false, exit: 2 }, stderr: 'boom' }).pass, false);
});

test('stranger with no downloader must be told to install yt-dlp', () => {
  const ok = 'This computer is missing yt-dlp, the free tool that reads YouTube captions.';
  assert.equal(judgeNoDownloader({ status: 2, stderr: ok }).pass, true);
  assert.equal(judgeNoDownloader({ status: 2, stderr: `${ok}\nNo English captions found` }).pass, false);
  assert.equal(judgeNoDownloader({ status: 1, stderr: ok }).pass, false);
});

test('stranger with no writer must be told to install one and get no notes file', () => {
  const ok = 'No AI writer is installed on this computer. Install one of: Claude Code (claude)';
  assert.equal(judgeNoWriter({ status: 3, stderr: ok, notesLeft: false }).pass, true);
  assert.equal(judgeNoWriter({ status: 3, stderr: ok, notesLeft: true }).pass, false);
  assert.equal(judgeNoWriter({ status: 2, stderr: 'No English captions found', notesLeft: false }).pass, false);
});

test('summary counts passes and leaves skipped cases out', () => {
  assert.equal(summary([{ pass: true }, { pass: false }], 42), 'bench: 1/2 passed in 42s');
  assert.equal(summary([{ pass: true }, { skipped: true }], 7), 'bench: 1/1 passed in 7s (1 skipped)');
});

test('findBinary looks on PATH, then in the extra dirs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytrail-bench-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mlx_whisper');
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  assert.equal(findBinary('mlx_whisper', { PATH: '/nonexistent' }, [dir]), file);
  assert.equal(findBinary('mlx_whisper', { PATH: dir }), file);
  assert.equal(findBinary('mlx_whisper', { PATH: '/nonexistent' }), null);
});

test('atris youtube bench runs the bench script and returns its status', () => {
  const calls = [];
  const code = runYoutubeBench(['--quick'], {
    spawnSync: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 1 };
    },
  });
  assert.equal(code, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.match(calls[0].args[0], /scripts[/\\]det[/\\]ytrail-bench\.js$/);
  assert.deepEqual(calls[0].args.slice(1), ['--quick']);
  assert.equal(calls[0].opts.stdio, 'inherit');
});
