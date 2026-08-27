'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = process.env.ATRIS_REPO_ROOT
  ? path.resolve(process.env.ATRIS_REPO_ROOT)
  : path.resolve(__dirname, '../../..');

const THIN_URL = 'https://www.youtube.com/watch?v=thin01';
const THIN_REFUSE = 'thin: no number or named mechanism. no brief.';
const THIN_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:08.000',
  'welcome back friends this is just a chat',
  '',
  '00:00:08.000 --> 00:00:16.000',
  'today we talk about feelings and vibes',
].join('\n');

function payload(score, extra = {}) {
  return {
    score,
    passed: score,
    total: 1,
    status: score === 1 ? 'pass' : 'fail',
    ...extra,
  };
}

function print(score, extra) {
  process.stdout.write(`${JSON.stringify(payload(score, extra))}\n`);
}

async function measure() {
  let youtubeCommand;
  let parseCaptionCues;
  try {
    ({ youtubeCommand, parseCaptionCues } = require(path.join(REPO_ROOT, 'commands', 'youtube.js')));
  } catch (error) {
    return print(0, { reason: `require failed: ${error.message}` });
  }

  if (typeof youtubeCommand !== 'function' || typeof parseCaptionCues !== 'function') {
    return print(0, { reason: 'youtube teach exports missing' });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-teach-thin-save-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    const lines = [];
    const status = await youtubeCommand(['teach', THIN_URL, '--save'], {
      cwd: dir,
      now: '2026-08-27',
      output: (line = '') => lines.push(String(line)),
      extractTeachSource: async () => ({
        id: 'thin01',
        title: 'a thin chat',
        url: THIN_URL,
        durationSeconds: 30,
        language: 'en',
        chapters: [{ start_time: 0, title: 'Welcome', end_time: 30 }],
        cues: parseCaptionCues(THIN_VTT),
      }),
    });

    const briefsDir = path.join(dir, 'atris', 'wiki', 'briefs');
    const briefNames = fs.existsSync(briefsDir)
      ? fs.readdirSync(briefsDir).filter((name) => !name.startsWith('.'))
      : [];
    const text = lines.join('\n');
    const refused = text.includes(THIN_REFUSE);
    const briefLanded = briefNames.length > 0;
    const score = status === 2 && refused && !briefLanded ? 1 : 0;
    return print(score, {
      exit: status,
      refused,
      brief_landed: briefLanded,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

measure().catch((error) => {
  print(0, { reason: error.message || String(error) });
});
