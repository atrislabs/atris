'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const YTNOTES = path.resolve(__dirname, '..', 'scripts', 'det', 'ytnotes');

// These tests fake `claude`. Pin the writer so a real agy on this machine
// never answers; the auto writer has its own tests below.
process.env.ATRIS_YTNOTES_ENGINE = process.env.ATRIS_YTNOTES_ENGINE || 'haiku';

// Today's date as a yt-dlp version, YYYY.MM.DD in local time.
function versionToday() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// ytnotes asks the fake yt-dlp for --version before anything else.
function answerVersion(version = versionToday()) {
  return `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`;
}

function writeExec(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

test('ytnotes keeps a written vtt when yt-dlp exits 429', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-429-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntrate1.en.vtt',
    'printf "%s\\n" "ntrate1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntrate1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntrate1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

// Mimics real yt-dlp: subtitle languages download in the order asked, the
// machine-translated "en" track returns 429, and without --ignore-errors the
// first failure stops the run before later languages are written.
test('ytnotes gets en-orig when the translated en track is rate limited', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-enorig-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/bash',
    answerVersion(),
    'langs=""; ignore=0; prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = "--sub-langs" ] && langs="$a"',
    '  [ "$a" = "--ignore-errors" ] && ignore=1',
    '  prev="$a"',
    'done',
    'printf "%s\\n" "ntorig1|Real Captions|Chan|0:02"',
    'IFS=, read -ra list <<< "$langs"',
    'for l in "${list[@]}"; do',
    '  case "$l" in',
    '    en-orig) printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The spoken words are here." > yt_ntorig1.en-orig.vtt ;;',
    '    en) echo "ERROR: Unable to download video subtitles for \'en\': HTTP Error 429: Too Many Requests" >&2',
    '        [ "$ignore" = 1 ] || exit 1 ;;',
    '  esac',
    'done',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Real Captions" "" "The spoken words are here."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntorig1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(path.join(work, 'ytnotes', 'yt_ntorig1.md'), 'utf8'), /spoken words/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes skips a leaked warning print line when choosing the video id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-warn-id-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntwarn1.en.vtt',
    'printf "%s\\n" "WARNING: [youtube] Incomplete data | retrying"',
    'printf "%s\\n" "ntwarn1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntwarn1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesDir = path.join(work, 'ytnotes');
  const notesPath = path.join(notesDir, 'yt_ntwarn1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  const leaked = fs.readdirSync(notesDir).filter((name) => /WARNING/i.test(name));
  assert.deepEqual(leaked, []);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes skips a None print line when choosing the video id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-none-id-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntnone1.en.vtt',
    'printf "%s\\n" "ntnone1|Omakase Clip|37signals|0:02"',
    'printf "%s\\n" "None|not a video id"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntnone1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesDir = path.join(work, 'ytnotes');
  const notesPath = path.join(notesDir, 'yt_ntnone1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  const leaked = fs.readdirSync(notesDir).filter((name) => /^yt_None\./.test(name));
  assert.deepEqual(leaked, []);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written manual English vtt when auto captions are absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-manual-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'has_write_subs=0',
    'for arg in "$@"; do',
    '  [ "$arg" = "--write-subs" ] && has_write_subs=1',
    'done',
    'if [ "$has_write_subs" -eq 1 ]; then',
    '  printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntman1.en.vtt',
    'fi',
    'printf "%s\\n" "ntman1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntman1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntman1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written auto English vtt when manual captions are absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-auto-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'has_write_auto=0',
    'for arg in "$@"; do',
    '  [ "$arg" = "--write-auto-subs" ] && has_write_auto=1',
    'done',
    'if [ "$has_write_auto" -eq 1 ]; then',
    '  printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntauto1.en-orig.vtt',
    'fi',
    'printf "%s\\n" "ntauto1|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntauto1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntauto1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written en-orig vtt when yt-dlp skips .en.vtt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-enorig-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntrate2.en-orig.vtt',
    'printf "%s\\n" "ntrate2|Omakase Clip|37signals|0:02"',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntrate2'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntrate2.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written vtt when yt-dlp print is empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-emptyprint-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntprint1.en.vtt',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntprint1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntprint1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a leftover vtt for a copied #t= url when print is empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-hash-t-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const notesWork = path.join(work, 'ytnotes');
  fs.mkdirSync(bin);
  fs.mkdirSync(notesWork, { recursive: true });
  fs.writeFileSync(path.join(notesWork, 'yt_nthash1.en.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'The omakase model has 80 people.',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=nthash1#t=30'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_nthash1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a leftover vtt for an /e/ url when print is empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-e-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const notesWork = path.join(work, 'ytnotes');
  fs.mkdirSync(bin);
  fs.mkdirSync(notesWork, { recursive: true });
  fs.writeFileSync(path.join(notesWork, 'yt_nte1.en.vtt'), [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:02.000',
    'The omakase model has 80 people.',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/e/nte1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_nte1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written vtt for a shorts url when print is empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-shorts-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntshort1.en.vtt',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/shorts/ntshort1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntshort1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps a written vtt for a nocookie embed url when print is empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-nocookie-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'printf "%s\\n" "WEBVTT" "" "00:00:00.000 --> 00:00:02.000" "The omakase model has 80 people." > yt_ntcookie1.en.vtt',
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube-nocookie.com/embed/ntcookie1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntcookie1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes keeps leftover clean.txt when captions are gone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-clean-txt-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const notesWork = path.join(work, 'ytnotes');
  fs.mkdirSync(bin);
  fs.mkdirSync(notesWork, { recursive: true });
  fs.writeFileSync(path.join(notesWork, 'yt_ntclean1.clean.txt'), [
    '[00:00]',
    'The omakase model has 80 people.',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'printf "%s\\n" "# Omakase Clip" "" "The omakase model has 80 people."',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntclean1'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  const notesPath = path.join(work, 'ytnotes', 'yt_ntclean1.md');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(notesPath), true);
  assert.match(fs.readFileSync(notesPath, 'utf8'), /omakase model/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No English captions/);
});

test('ytnotes does not invent-keep another video leftover clean.txt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-clean-other-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  const notesWork = path.join(work, 'ytnotes');
  fs.mkdirSync(bin);
  fs.mkdirSync(notesWork, { recursive: true });
  fs.writeFileSync(path.join(notesWork, 'yt_otherid.clean.txt'), [
    '[00:00]',
    'The omakase model has 80 people.',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'echo "claude should not run" >&2',
    'exit 1',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=ntclean2'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr || '', /No English captions/);
  assert.equal(fs.existsSync(path.join(work, 'ytnotes', 'yt_ntclean2.md')), false);
});

test('ytnotes still fails a 429 when no captions were written', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ytnotes-empty429-'));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/sh',
    answerVersion(),
    'echo "ERROR: [youtube] HTTP Error 429: Too Many Requests" >&2',
    'exit 1',
    '',
  ].join('\n'));

  writeExec(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'echo "claude should not run" >&2',
    'exit 1',
    '',
  ].join('\n'));

  const result = spawnSync(YTNOTES, ['https://www.youtube.com/watch?v=empty429'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/usr/bin'}`,
      TMPDIR: work,
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr || '', /No English captions/);
  assert.equal(fs.existsSync(path.join(work, 'ytnotes', 'yt_empty429.md')), false);
});

function runNoCaptionNotes(label, { withWhisper, whisperVtt, extraEnv = {}, audioFailures = 0, extraBins = {}, withClaude = true, withYtDlp = true, ytDlpVersion }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `atris-ytnotes-${label}-`));
  const bin = path.join(tmp, 'bin');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(bin);
  fs.mkdirSync(work);

  // Captions request writes nothing; the audio request (-f bestaudio) writes audio.
  writeExec(path.join(bin, 'yt-dlp'), [
    '#!/bin/bash',
    answerVersion(ytDlpVersion),
    'out=""; audio=0; prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = "-o" ] && out="$a"',
    '  [ "$prev" = "-f" ] && audio=1',
    '  prev="$a"',
    'done',
    // The first audioFailures audio requests get a 403, like real YouTube.
    `if [ "$audio" = 1 ]; then n=$(cat "${'$'}{TMPDIR}/audio_tries" 2>/dev/null || echo 0); echo $((n + 1)) > "${'$'}{TMPDIR}/audio_tries"; if [ "$n" -lt ${audioFailures} ]; then echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1; fi; printf "fake-audio" > "${'$'}{out/\\%(ext)s/m4a}"; exit 0; fi`,
    `printf "%s\\n" "${label}|No Caption Talk|Chan|1:02:00"`,
    '',
  ].join('\n'));

  if (withWhisper) {
    writeExec(path.join(bin, 'mlx_whisper'), [
      '#!/bin/bash',
      'dir=""; name=""; prev=""',
      'for a in "$@"; do',
      '  [ "$prev" = "--output-dir" ] && dir="$a"',
      '  [ "$prev" = "--output-name" ] && name="$a"',
      '  prev="$a"',
      'done',
      // Like the real CLI: anything after a dot in --output-name is dropped.
      `printf "%s\\n" ${whisperVtt.map((line) => JSON.stringify(line)).join(' ')} > "$dir/\${name%.*}.vtt"`,
      '',
    ].join('\n'));
  }

  if (withClaude) {
    writeExec(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'cat > /dev/null',
      'printf "%s\\n" "# No Caption Talk" "" "Spoken only in audio."',
      '',
    ].join('\n'));
  }
  if (!withYtDlp) fs.rmSync(path.join(bin, 'yt-dlp'));
  for (const [name, body] of Object.entries(extraBins)) writeExec(path.join(bin, name), body);

  // Keep the real ~/.local/bin (and any real mlx_whisper) off PATH.
  const result = spawnSync(YTNOTES, [`https://www.youtube.com/watch?v=${label}`], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      HOME: tmp,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: work,
      ...extraEnv,
    },
  });
  return { result, dir: path.join(work, 'ytnotes') };
}

const LOCAL_VTT = [
  'WEBVTT', '',
  '00:05.000 --> 00:07.000', 'Spoken only in audio.', '',
  '01:01:40.000 --> 01:01:42.000', 'Last words after an hour.', '',
];

test('ytnotes transcribes the audio locally when a video has no captions', () => {
  const { result, dir } = runNoCaptionNotes('nocap1', { withWhisper: true, whisperVtt: LOCAL_VTT });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Transcribing the audio on this computer/);
  assert.doesNotMatch(result.stderr, /No English captions/);
  const clean = fs.readFileSync(path.join(dir, 'yt_nocap1.clean.txt'), 'utf8');
  assert.match(clean, /\[00:05\]\nSpoken only in audio\./);
  assert.match(clean, /\[01:01:40\]\nLast words after an hour\./);
  assert.equal(fs.readdirSync(dir).some((f) => f.includes('.audio.')), false, 'audio is deleted');
});

test('ytnotes without a local speech model prints the paid command', () => {
  const { result, dir } = runNoCaptionNotes('nocap2', { withWhisper: false });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /No English captions found/);
  assert.match(result.stderr, /no local speech model/);
  assert.match(result.stderr, /atris youtube process "https:\/\/www\.youtube\.com\/watch\?v=nocap2"/);
  assert.equal(fs.existsSync(path.join(dir, 'yt_nocap2.md')), false);
});

test('ytnotes local transcription can be turned off', () => {
  const { result } = runNoCaptionNotes('nocap3', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    extraEnv: { ATRIS_YTNOTES_LOCAL_TRANSCRIBE: '0' },
  });

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /Transcribing/);
  assert.match(result.stderr, /atris youtube process/);
});

test('ytnotes retries a refused audio download', () => {
  const { result, dir } = runNoCaptionNotes('nocap4', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    audioFailures: 2,
    extraEnv: { ATRIS_YTNOTES_RETRY_SECONDS: '0' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'yt_nocap4.clean.txt'), 'utf8'), /Spoken only in audio/);
});

test('ytnotes gives up after three refused audio downloads', () => {
  const { result } = runNoCaptionNotes('nocap5', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    audioFailures: 3,
    extraEnv: { ATRIS_YTNOTES_RETRY_SECONDS: '0' },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Local transcription failed \(download: ERROR: unable to download video data: HTTP Error 403/);
  assert.match(result.stderr, /atris youtube process/);
});

test('ytnotes auto writer uses Gemini through agy when it answers', () => {
  const { result, dir } = runNoCaptionNotes('auto1', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'auto' },
    extraBins: { agy: '#!/bin/sh\nprintf "%s\\n" "# From Gemini" "" "Spoken only in audio."\n' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'yt_auto1.md'), 'utf8'), /# From Gemini/);
  assert.doesNotMatch(result.stderr, /Haiku instead/);
});

test('ytnotes auto writer falls back to Haiku when Gemini fails', () => {
  const { result, dir } = runNoCaptionNotes('auto2', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'auto' },
    extraBins: { agy: '#!/bin/sh\necho "quota exceeded" >&2\nexit 1\n' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /writing the notes with Haiku instead/);
  assert.match(fs.readFileSync(path.join(dir, 'yt_auto2.md'), 'utf8'), /# No Caption Talk/);
});

test('ytnotes auto writer falls back to Haiku when agy is not installed', () => {
  const { result, dir } = runNoCaptionNotes('auto3', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'auto' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'yt_auto3.md'), 'utf8'), /# No Caption Talk/);
});

test('ytnotes auto writer uses Codex when neither Gemini nor Claude is installed', () => {
  const { result, dir } = runNoCaptionNotes('auto4', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    withClaude: false,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'auto' },
    extraBins: { codex: '#!/bin/sh\nprintf "%s\\n" "# From Codex" "" "Spoken only in audio."\n' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(path.join(dir, 'yt_auto4.md'), 'utf8'), /# From Codex/);
});

test('ytnotes with no AI writer says what to install and leaves no empty notes', () => {
  const { result, dir } = runNoCaptionNotes('auto5', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    withClaude: false,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'auto' },
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /No AI writer is installed on this computer/);
  assert.match(result.stderr, /Claude Code \(claude\)/);
  assert.match(result.stderr, /atris youtube process/);
  assert.equal(fs.existsSync(path.join(dir, 'yt_auto5.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'yt_auto5.clean.txt')), true);
});

test('ytnotes with a pinned writer that is missing fails instead of printing nothing', () => {
  const { result, dir } = runNoCaptionNotes('auto6', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    withClaude: false,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'haiku' },
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /claude: not installed/);
  assert.match(result.stderr, /No notes were written/);
  assert.equal(fs.existsSync(path.join(dir, 'yt_auto6.md')), false);
});

test('ytnotes without yt-dlp says to install it instead of blaming captions', () => {
  const { result } = runNoCaptionNotes('noytdlp', { withWhisper: false, withYtDlp: false });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing yt-dlp/);
  assert.match(result.stderr, /brew install yt-dlp/);
  assert.doesNotMatch(result.stderr, /No English captions/);
});

test('ytnotes warns when yt-dlp is old and still writes the notes', () => {
  const { result, dir } = runNoCaptionNotes('stale1', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    ytDlpVersion: '2025.01.01',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Your yt-dlp is \d+ days old, and YouTube often blocks old copies\. Update it: brew upgrade yt-dlp \(Mac\) or pipx upgrade yt-dlp/);
  assert.match(fs.readFileSync(path.join(dir, 'yt_stale1.md'), 'utf8'), /# No Caption Talk/);
});

test('ytnotes says nothing about a yt-dlp released today', () => {
  const { result } = runNoCaptionNotes('fresh1', { withWhisper: true, whisperVtt: LOCAL_VTT });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /yt-dlp is/);
});

test('ytnotes says nothing when the yt-dlp version does not parse', () => {
  const { result } = runNoCaptionNotes('oddver1', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    ytDlpVersion: 'nightly',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /yt-dlp is/);
});

test('ytnotes auto names the writer that wrote the notes', () => {
  const { result } = runNoCaptionNotes('byline1', {
    withWhisper: true,
    whisperVtt: LOCAL_VTT,
    extraEnv: { ATRIS_YTNOTES_ENGINE: 'auto' },
    extraBins: { agy: '#!/bin/sh\nprintf "%s\\n" "# From Gemini" "" "Spoken only in audio."\n' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /^notes by Gemini$/m);
});

test('ytnotes names a pinned writer once the notes are written', () => {
  const { result } = runNoCaptionNotes('byline2', { withWhisper: true, whisperVtt: LOCAL_VTT });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /^notes by haiku$/m);
});
