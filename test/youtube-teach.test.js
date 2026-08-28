'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseTeachArgs,
  parseCaptionCues,
  normalizeChapters,
  sliceCuesForChapter,
  formatTeachLesson,
  extractTeachNumbers,
  extractTeachMechanisms,
  extractTeachSource,
  isThinTeachLesson,
  TEACH_THIN_REFUSE,
  teachExperimentSlug,
  youtubeCommand,
} = require('../commands/youtube');
const { ephemeralApplyMessage } = require('../lib/apply-gate');

const REPO_ROOT = path.resolve(__dirname, '..');
const VALIDATE_PY = path.join(REPO_ROOT, 'atris', 'experiments', 'validate.py');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'atris.js');

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

const pythonCmd = findPython();

const TEACH_URL = 'https://www.youtube.com/watch?v=teach01';
const TEACH_VTT = [
  'WEBVTT',
  '',
  '00:00:02.000 --> 00:00:06.000',
  '37signals has 80 people and uses the omakase model',
  '',
  '00:00:20.000 --> 00:00:24.000',
  'Basecamp ships once a week',
  '',
  '00:10:00.000 --> 00:10:06.000',
  'Shape Up is a six-week cycle with a cooldown',
  '',
].join('\n');

const TEACH_CHAPTERS = [
  { start_time: 0, title: 'Omakase', end_time: 60 },
  { start_time: 600, title: 'Shape Up', end_time: 900 },
];

const LEX_URL = 'https://www.youtube.com/watch?v=NYFGCESmikA';
const LEX_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:08.000',
  'Who would not get delirious if a genie says',
  '',
  '00:00:08.000 --> 00:00:16.000',
  'every feature you have ever dreamed of in an operating',
  'system I can deliver',
  '',
  '00:00:16.000 --> 00:00:22.000',
  'most of them in five minutes a few in 20',
  '',
  '00:00:22.000 --> 00:00:30.000',
  'I want the operating system that can install',
  'in less than 60 seconds',
  '',
  '00:00:30.000 --> 00:00:38.000',
  'I want the diver watch that can go down the Mariana Trench',
  '',
  '00:00:38.000 --> 00:00:46.000',
  'just think "holy fuck, i\'m alive."',
  '',
  '00:00:46.000 --> 00:00:54.000',
  'The Overton window does not open itself',
  '',
].join('\n');

const LEX_CHAPTERS = [
  { start_time: 0, title: 'Episode highlight', end_time: 87 },
  { start_time: 87, title: 'Introduction', end_time: 176 },
];

const THIN_URL = 'https://www.youtube.com/watch?v=thin01';
const THIN_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:08.000',
  'welcome back friends this is just a chat',
  '',
  '00:00:08.000 --> 00:00:16.000',
  'today we talk about feelings and vibes',
].join('\n');
const THIN_CHAPTERS = [
  { start_time: 0, title: 'Welcome', end_time: 30 },
];

function lessonBlock(text, name) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line === name);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) break;
    out.push(lines[i]);
  }
  return out;
}

function lexHighlightLesson() {
  const chapters = normalizeChapters(LEX_CHAPTERS, 176);
  const cues = sliceCuesForChapter(parseCaptionCues(LEX_VTT), chapters[0]);
  return {
    chapters,
    cues,
    body: cues.map((cue) => cue.text).join(' '),
    text: formatTeachLesson({
      url: LEX_URL,
      section: 1,
      chapters,
      chapter: chapters[0],
      cues,
      title: 'DHH: Future of Programming | Lex Fridman Podcast #501',
    }),
  };
}

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runExperimentsKeep(cwd, slug) {
  return spawnSync(process.execPath, [CLI_PATH, 'experiments', 'keep', slug], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(pythonCmd ? { ATRIS_EXPERIMENTS_PYTHON: pythonCmd } : {}),
    },
  });
}

function runExperimentsRevert(cwd, slug) {
  return spawnSync(process.execPath, [CLI_PATH, 'experiments', 'revert', slug], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(pythonCmd ? { ATRIS_EXPERIMENTS_PYTHON: pythonCmd } : {}),
    },
  });
}

function assertTeachApplyClaimable(cwd, { id, section, tokens = [], date = '2026-08-27' } = {}) {
  const packRel = `atris/experiments/${teachExperimentSlug(id, section)}`;
  const applyRel = `atris/wiki/briefs/youtube-${id}-s${section}.apply.md`;
  const sidecar = fs.readFileSync(path.join(cwd, applyRel), 'utf8');
  assert.match(sidecar, new RegExp(escapeRe(packRel)));
  assert.match(sidecar, /keep only if measure\.py moves 0→1/);
  assert.match(sidecar, /scores 1 only when the fixture contains the check tokens/);
  for (const token of tokens) {
    assert.doesNotMatch(sidecar, new RegExp(escapeRe(token), 'i'));
  }
  const journal = fs.readFileSync(path.join(cwd, 'atris', 'logs', date.slice(0, 4), `${date}.md`), 'utf8');
  assert.match(journal, /\[claimable\] apply: /);
  assert.match(journal, new RegExp(escapeRe(packRel)));
  assert.match(journal, /keep only if measure\.py moves 0→1/);
  assert.match(journal, /scores 1 only when the fixture contains the check tokens/);
  return { packRel, applyRel, sidecar, journal };
}

function fixtureSource() {
  return {
    id: 'teach01',
    title: 'DHH on Lex Fridman',
    url: TEACH_URL,
    durationSeconds: 900,
    language: 'en',
    chapters: TEACH_CHAPTERS,
    cues: parseCaptionCues(TEACH_VTT),
  };
}

function lexSource() {
  return {
    id: 'NYFGCESmikA',
    title: 'DHH: Future of Programming | Lex Fridman Podcast #501',
    url: LEX_URL,
    durationSeconds: 176,
    language: 'en',
    chapters: LEX_CHAPTERS,
    cues: parseCaptionCues(LEX_VTT),
  };
}

function thinSource() {
  return {
    id: 'thin01',
    title: 'a thin chat',
    url: THIN_URL,
    durationSeconds: 30,
    language: 'en',
    chapters: THIN_CHAPTERS,
    cues: parseCaptionCues(THIN_VTT),
  };
}

test('teachExperimentSlug lowercases the video id for validate.py', () => {
  assert.equal(teachExperimentSlug('teach01', 1), 'teach-teach01-s1');
  assert.equal(teachExperimentSlug('NYFGCESmikA', 1), 'teach-nyfgcesmika-s1');
  assert.equal(teachExperimentSlug('abc_def', 2), 'teach-abc-def-s2');
});

test('parseTeachArgs defaults to section 1 and accepts --section and --save', () => {
  assert.deepEqual(parseTeachArgs([TEACH_URL]), {
    help: false,
    save: false,
    json: false,
    skip: false,
    recap: null,
    url: TEACH_URL,
    section: 1,
  });
  assert.equal(parseTeachArgs([TEACH_URL, '--section', '2']).section, 2);
  assert.equal(parseTeachArgs([TEACH_URL, '--section=3']).section, 3);
  assert.equal(parseTeachArgs([TEACH_URL, '--save']).save, true);
  assert.equal(parseTeachArgs([TEACH_URL, '--recap', 'omakase model']).recap, 'omakase model');
  assert.equal(parseTeachArgs([TEACH_URL, '--recap=omakase model']).recap, 'omakase model');
  assert.equal(parseTeachArgs(['recap', 'omakase model']).recap, 'omakase model');
  assert.equal(parseTeachArgs([TEACH_URL, '--skip']).skip, true);
  assert.equal(parseTeachArgs(['skip']).skip, true);
  assert.equal(parseTeachArgs([TEACH_URL, '--json']).json, true);
  assert.equal(parseTeachArgs(['--help']).help, true);
  assert.throws(() => parseTeachArgs([TEACH_URL, '--paid']), /drop --paid/);
  assert.throws(() => parseTeachArgs([TEACH_URL, '--section', '0']), /positive integer/);
  assert.throws(() => parseTeachArgs(['recap']), /unpaid check/);
});

test('parseCaptionCues and sliceCuesForChapter keep one chapter from fixture VTT', () => {
  const cues = parseCaptionCues(TEACH_VTT);
  const chapters = normalizeChapters(TEACH_CHAPTERS, 900);
  assert.equal(cues.length, 3);
  assert.equal(chapters.length, 2);

  const first = sliceCuesForChapter(cues, chapters[0]);
  const second = sliceCuesForChapter(cues, chapters[1]);
  assert.equal(first.length, 2);
  assert.match(first.map((cue) => cue.text).join(' '), /80 people/);
  assert.match(first.map((cue) => cue.text).join(' '), /omakase/);
  assert.doesNotMatch(first.map((cue) => cue.text).join(' '), /Shape Up/);
  assert.equal(second.length, 1);
  assert.match(second[0].text, /six-week cycle/);
});

test('lex highlight fixture keeps claim-bearing numbers and named mechanisms', () => {
  const { body, text } = lexHighlightLesson();
  assert.match(body, /holy fuck/i);
  assert.match(body, /\b20\b/);
  assert.match(body, /60 seconds/i);
  assert.match(body, /overton window/i);

  const numbers = extractTeachNumbers(body);
  const mechanisms = extractTeachMechanisms(body);
  for (const line of numbers) {
    assert.match(line, /\d/);
    assert.match(line, /[a-z]/i);
    assert.doesNotMatch(line, /^\d[\d,]*$/);
  }
  for (const line of mechanisms) {
    assert.doesNotMatch(line, /holy|fuck|i'm alive/i);
    assert.doesNotMatch(line, /^(who|every|holy|the overton|mariana trench)$/);
    assert.match(line, /window|model|principle|pattern|loop|cycle|method|rule|doctrine|framework|heuristic|\d+[a-z]/i);
  }
  assert.ok(numbers.some((line) => /60 seconds to install/i.test(line)));
  assert.ok(mechanisms.some((line) => /overton window/i.test(line)));
  assert.equal(mechanisms.some((line) => /holy fuck/i.test(line)), false);

  const printedNumbers = lessonBlock(text, 'numbers');
  const printedMechanisms = lessonBlock(text, 'mechanisms');
  const check = lessonBlock(text, 'check')[0] || '';
  for (const line of printedNumbers) {
    if (line === 'none') continue;
    assert.match(line, /\d/);
    assert.match(line, /[a-z]/i);
    assert.doesNotMatch(line, /^\d[\d,]*$/);
  }
  for (const line of printedMechanisms) {
    if (line === 'none') continue;
    assert.doesNotMatch(line, /holy|fuck/i);
  }
  assert.match(text, /60 seconds to install/);
  assert.match(text, /overton window/);
  assert.match(check, /overton window|60 seconds to install/);
  assert.doesNotMatch(check, /holy|fuck/i);
  assert.match(text, /next: atris youtube teach "https:\/\/www\.youtube\.com\/watch\?v=NYFGCESmikA" --section 2/);
});

test('formatTeachLesson prints numbers, mechanisms, one check, and a quoted next line', () => {
  const cues = parseCaptionCues(TEACH_VTT);
  const chapters = normalizeChapters(TEACH_CHAPTERS, 900);
  const text = formatTeachLesson({
    url: TEACH_URL,
    section: 1,
    chapters,
    chapter: chapters[0],
    cues: sliceCuesForChapter(cues, chapters[0]),
    title: 'DHH on Lex Fridman',
  });

  assert.match(text, /section 1\/2  omakase/);
  assert.match(text, /80 people/);
  assert.match(text, /omakase/);
  assert.match(text, /check\nwhat is /);
  assert.match(text, /next: atris youtube teach "https:\/\/www\.youtube\.com\/watch\?v=teach01" --section 2/);
  assert.doesNotMatch(text, /six-week/);
});

test('youtube help lists youtube teach', async () => {
  const out = collect();
  const status = await youtubeCommand(['--help'], { output: out.output });
  assert.equal(status, 0);
  assert.match(out.text(), /teach <youtube-url>/);
  assert.match(out.text(), /--section N/);
  assert.match(out.text(), /--recap TEXT/);
  assert.match(out.text(), /--skip/);
  assert.match(out.text(), /one chapter from local captions/);
});

test('youtube teach prints one chapter from fixture captions and chapters', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-print-'));
  const out = collect();
  let apiCalls = 0;
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
    apiRequestJson: async () => {
      apiCalls += 1;
      return { ok: true, status: 200, data: {} };
    },
  });

  assert.equal(status, 0);
  assert.equal(apiCalls, 0);
  const text = out.text();
  assert.match(text, /section 1\/2  omakase/);
  assert.match(text, /80 people/);
  assert.match(text, /omakase/);
  assert.match(text, /check\nwhat is /);
  assert.match(text, /next: atris youtube teach "https:\/\/www\.youtube\.com\/watch\?v=teach01" --section 2/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
  assert.doesNotMatch(text, /six-week/);
  assert.doesNotMatch(text, /process_youtube/);
});

test('youtube teach prints the lex highlight as 60s install, Overton, and a real check', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-lex-'));
  const out = collect();
  const status = await youtubeCommand(['teach', LEX_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => ({
      id: 'NYFGCESmikA',
      title: 'DHH: Future of Programming | Lex Fridman Podcast #501',
      url: LEX_URL,
      durationSeconds: 176,
      language: 'en',
      chapters: LEX_CHAPTERS,
      cues: parseCaptionCues(LEX_VTT),
    }),
  });

  assert.equal(status, 0);
  const text = out.text();
  assert.match(text, /60 seconds to install/);
  assert.match(text, /overton window/);
  assert.match(text, /check\nwhat is the overton window\?/);
  assert.doesNotMatch(text, /holy fuck/);
  assert.doesNotMatch(text, /^20$/m);
  assert.doesNotMatch(text, /^60$/m);
});

test('youtube teach --section 2 prints the second chapter after skip', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-s2-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const skipped = await youtubeCommand(['teach', '--skip'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const text = out.text();
  assert.match(text, /section 2\/2  shape up/);
  assert.match(text, /six-week/);
  assert.doesNotMatch(text, /80 people/);
  assert.match(text, /next: last section/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
});

test('youtube teach without --save writes no atris files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-nosave-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
  assert.doesNotMatch(out.text(), /next: apply /);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
});

test('youtube teach --save writes one pack-named apply claimable', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.match(out.text(), /next: apply atris\/experiments\/teach-teach01-s1\. keep only if measure\.py moves 0→1/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1', 'measure.py')), true);
  const claim = assertTeachApplyClaimable(cwd, {
    id: 'teach01',
    section: 1,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.doesNotMatch(claim.sidecar, /fill this/i);
  assert.doesNotMatch(claim.journal, /apply: fill this/);
});

test('youtube unsave after rich teach --save removes briefs apply and every section pack', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-unsave-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const save1 = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  const skipped = await youtubeCommand(['teach', '--skip'], {
    cwd,
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);
  const save2 = await youtubeCommand(['teach', TEACH_URL, '--section', '2', '--save'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(save1, 0);
  assert.equal(save2, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.apply.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1', 'measure.py')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s2', 'measure.py')), true);

  const keepDir = path.join(cwd, 'atris', 'experiments', 'teach-thin-save');
  fs.mkdirSync(keepDir, { recursive: true });
  fs.writeFileSync(path.join(keepDir, 'keep.txt'), 'stay\n');

  const out = collect();
  const status = await youtubeCommand(['unsave', 'teach01'], {
    cwd,
    output: out.output,
    runner: () => {
      throw new Error('unsave must not run notes');
    },
  });

  assert.equal(status, 0);
  assert.match(out.text(), /removed /);
  assert.match(out.text(), /atris\/wiki\/briefs\/youtube-teach01-s1\.md/);
  assert.match(out.text(), /atris\/wiki\/briefs\/youtube-teach01-s1\.apply\.md/);
  assert.match(out.text(), /atris\/experiments\/teach-teach01-s1/);
  assert.match(out.text(), /atris\/experiments\/teach-teach01-s2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s2.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s2.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s2')), false);
  assert.equal(fs.existsSync(path.join(keepDir, 'keep.txt')), true);
});

test('youtube teach --save on lex highlight files the brief and a pack-named apply', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-lex-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', LEX_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => lexSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /60 seconds to install/);
  assert.match(out.text(), /overton window/);
  assert.match(out.text(), /next: apply atris\/experiments\/teach-nyfgcesmika-s1\. keep only if measure\.py moves 0→1/);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-NYFGCESmikA-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-nyfgcesmika-s1', 'measure.py')), true);
  assertTeachApplyClaimable(cwd, {
    id: 'NYFGCESmikA',
    section: 1,
    tokens: ['overton window', '60 seconds to install', 'what is the overton window?'],
  });
});

test('youtube teach --save refuses a thin chapter and writes no brief', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-save-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const source = thinSource();
  const body = source.cues.map((cue) => cue.text).join(' ');
  const numbers = extractTeachNumbers(body);
  const mechanisms = extractTeachMechanisms(body);
  assert.deepEqual(numbers, []);
  assert.deepEqual(mechanisms, []);
  assert.equal(isThinTeachLesson({ numbers, mechanisms }), true);

  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => source,
  });

  const text = out.text();
  assert.equal(status, 2);
  assert.match(text, /numbers\nnone/);
  assert.match(text, /mechanisms\nnone/);
  assert.match(text, new RegExp(TEACH_THIN_REFUSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01-s1.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-thin01-s1.apply.md')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube teach rich --save mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-mint-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1');
  for (const name of ['program.md', 'measure.py', 'loop.py', 'reset.py', 'results.tsv']) {
    assert.equal(fs.existsSync(path.join(packDir, name)), true, name);
  }
  const program = fs.readFileSync(path.join(packDir, 'program.md'), 'utf8');
  assert.ok(program.length < 1200);
  assert.match(program, /omakase model/);
  const measureSrc = fs.readFileSync(path.join(packDir, 'measure.py'), 'utf8');
  assert.match(measureSrc, /what is the omakase model\?/);
  assert.match(measureSrc, /omakase model/);

  const validated = spawnSync(pythonCmd, [VALIDATE_PY, packDir], { encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  assert.match(validated.stdout, /PASS/);

  function scoreFixture(text) {
    const fixture = path.join(cwd, 'fixture.md');
    fs.writeFileSync(fixture, text);
    const measured = spawnSync(pythonCmd, [path.join(packDir, 'measure.py')], {
      cwd: packDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_REPO_ROOT: cwd,
        ATRIS_TEACH_MEASURE_FIXTURE: fixture,
      },
    });
    assert.equal(measured.status, 0, measured.stderr || measured.stdout);
    return JSON.parse(measured.stdout.trim().split('\n').pop());
  }

  const miss = scoreFixture('feelings and vibes and a chat about nothing');
  assert.equal(miss.score, 0);
  assert.equal(miss.passed, 0);
  assert.equal(miss.total, 1);
  assert.equal(miss.status, 'fail');

  const hit = scoreFixture('keep the omakase model as the default stack');
  assert.equal(hit.score, 1);
  assert.equal(hit.passed, 1);
  assert.equal(hit.total, 1);
  assert.equal(hit.status, 'pass');

  const claim = assertTeachApplyClaimable(cwd, {
    id: 'teach01',
    section: 1,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  const stub = spawnSync(pythonCmd, [path.join(packDir, 'measure.py')], {
    cwd: packDir,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  const stubPayload = JSON.parse(stub.stdout.trim().split('\n').pop());
  assert.equal(stubPayload.score, 0);
  assert.doesNotMatch(claim.sidecar, /omakase model/i);
});

test('youtube teach rich --save apply sidecar omits check tokens so measure.py scores 0', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-apply-claim-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const claim = assertTeachApplyClaimable(cwd, {
    id: 'teach01',
    section: 1,
    tokens: ['omakase model', 'what is the omakase model?'],
  });
  assert.match(claim.sidecar, /^change: apply atris\/experiments\/teach-teach01-s1$/m);
  assert.match(claim.sidecar, /^receipt: keep only if measure\.py moves 0→1\. scores 1 only when the fixture contains the check tokens\.$/m);
  assert.match(
    claim.journal,
    /\[claimable\] apply: atris\/experiments\/teach-teach01-s1\. keep only if measure\.py moves 0→1\. scores 1 only when the fixture contains the check tokens\./,
  );

  const measured = spawnSync(pythonCmd, [path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1', 'measure.py')], {
    cwd: path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1'),
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(measured.status, 0, measured.stderr || measured.stdout);
  const payload = JSON.parse(measured.stdout.trim().split('\n').pop());
  assert.equal(payload.score, 0);
  assert.equal(payload.status, 'fail');
});

test('experiments keep refuses a minted teach pack at 0 and keeps after check tokens', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-keep-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1');
  const applyPath = path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.apply.md');
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  const refused = runExperimentsKeep(cwd, 'teach-teach01-s1');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert teach-teach01-s1: measure\.py stayed 0\. refuse keep\./);
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  fs.appendFileSync(applyPath, '\nkeep the omakase model as the default stack\n');
  const kept = runExperimentsKeep(cwd, 'teach-teach01-s1');
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /keep teach-teach01-s1: measure\.py moved 0→1/);
});

test('experiments revert runs minted reset.py after a refused keep', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-revert-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'teach-teach01-s1');
  assert.equal(fs.existsSync(path.join(packDir, 'reset.py')), true);

  const refused = runExperimentsKeep(cwd, 'teach-teach01-s1');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert teach-teach01-s1: measure\.py stayed 0\. refuse keep\./);

  const reverted = runExperimentsRevert(cwd, 'teach-teach01-s1');
  assert.equal(reverted.status, 0, reverted.stderr || reverted.stdout);
  assert.match(reverted.stdout, /revert teach-teach01-s1: reset\.py ran/);
  assert.equal(fs.existsSync(path.join(packDir, 'reset.py')), true);
});

test('youtube teach thin chapter without --save still writes no atris files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-thin-nosave-'));
  const out = collect();
  const status = await youtubeCommand(['teach', THIN_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => thinSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /numbers\nnone/);
  assert.doesNotMatch(out.text(), /thin: no number or named mechanism/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('extractTeachSource reads fixture yt-dlp chapters and VTT without network', async () => {
  const source = await extractTeachSource(TEACH_URL, {
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        id: 'teach01',
        title: 'DHH on Lex Fridman',
        duration: 900,
        chapters: TEACH_CHAPTERS,
        automatic_captions: {
          en: [{ ext: 'vtt', url: 'https://www.youtube.com/api/timedtext?v=teach01' }],
        },
      }),
    }),
    fetchCaptionText: async () => TEACH_VTT,
  });

  assert.equal(source.id, 'teach01');
  assert.equal(source.chapters.length, 2);
  assert.equal(source.chapters[0].title, 'Omakase');
  assert.equal(source.cues.length, 3);
  assert.match(source.cues[0].text, /80 people/);
});

test('youtube teach without captions prints no apply next-step', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-nocap-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => null,
  });

  assert.equal(status, 2);
  assert.match(out.text(), /no english captions/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
});

test('youtube teach empty tmp section 1 still prints the check and writes no atris tree', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-empty-'));
  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 0);
  assert.match(out.text(), /section 1\/2  omakase/);
  assert.match(out.text(), /check\nwhat is the omakase model\?/);
  assert.match(out.text(), /next: atris youtube teach "https:\/\/www\.youtube\.com\/watch\?v=teach01" --section 2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
});

test('youtube teach --section 2 without recap exits 2 and prints the unpaid check', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-unpaid-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });

  assert.equal(status, 2);
  assert.equal(extractCalls, 0);
  assert.equal(out.text().trim(), 'what is the omakase model?');
  assert.doesNotMatch(out.text(), /section 2\/2/);
  assert.doesNotMatch(out.text(), /shape up/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
});

test('youtube teach --json stays quiet when a recap is still owed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-json-owed-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2', '--json'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });

  assert.equal(status, 2);
  assert.equal(out.text().trim(), '');
  assert.doesNotMatch(out.text(), /omakase|section 2|\{/);
});

test('youtube teach recap with check tokens unlocks the next section', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-ok-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapOut = collect();
  const recapped = await youtubeCommand(['teach', 'recap', 'the omakase model is the default stack'], {
    cwd,
    output: recapOut.output,
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);
  assert.doesNotMatch(recapOut.text(), /section 2\/2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
  assert.match(out.text(), /six-week/);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 1);
});

test('youtube teach wrong recap still refuses the next section', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-wrong-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapOut = collect();
  const recapped = await youtubeCommand(['teach', '--recap', 'feelings and vibes'], {
    cwd,
    output: recapOut.output,
    extractTeachSource: async () => {
      throw new Error('wrong recap must not fetch captions');
    },
  });
  assert.equal(recapped, 2);
  assert.equal(recapOut.text().trim(), 'what is the omakase model?');

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 2);
  assert.equal(out.text().trim(), 'what is the omakase model?');
  assert.doesNotMatch(out.text(), /section 2\/2/);
});

test('youtube teach --skip unlocks the next section without claiming an answer', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-skip-'));
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const skipOut = collect();
  const skipped = await youtubeCommand(['teach', TEACH_URL, '--skip'], {
    cwd,
    output: skipOut.output,
    extractTeachSource: async () => {
      throw new Error('skip must not fetch captions');
    },
  });
  assert.equal(skipped, 0);
  assert.doesNotMatch(skipOut.text(), /answered|correct|got it/i);
  assert.doesNotMatch(skipOut.text(), /section 2\/2/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris')), false);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2'], {
    cwd,
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.match(out.text(), /section 2\/2  shape up/);
});

test('youtube teach recap writes no wiki brief apply or experiment pack', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-recap-nowiki-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const first = await youtubeCommand(['teach', TEACH_URL], {
    cwd,
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);

  const recapped = await youtubeCommand(['teach', TEACH_URL, '--recap', '80 people'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => {
      throw new Error('recap must not fetch captions');
    },
  });
  assert.equal(recapped, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
});

test('youtube teach --save path stays unchanged after a recap unlock', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-teach-save-recap-'));
  fs.mkdirSync(path.join(cwd, 'atris', 'wiki'), { recursive: true });
  const first = await youtubeCommand(['teach', TEACH_URL, '--save'], {
    cwd,
    now: '2026-08-27',
    output: () => {},
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(first, 0);
  const recapped = await youtubeCommand(['teach', 'recap', 'omakase model'], {
    cwd,
    output: () => {},
  });
  assert.equal(recapped, 0);

  const out = collect();
  const status = await youtubeCommand(['teach', TEACH_URL, '--section', '2', '--save'], {
    cwd,
    now: '2026-08-27',
    output: out.output,
    extractTeachSource: async () => fixtureSource(),
  });
  assert.equal(status, 0);
  assert.equal(out.lines.filter((line) => line === ephemeralApplyMessage('teach')).length, 0);
  assert.match(out.text(), /next: apply atris\/experiments\/teach-teach01-s2\. keep only if measure\.py moves 0→1/);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s1.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'youtube-teach01-s2.md')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'teach-teach01-s2', 'measure.py')), true);
});

test('youtube teach --paid is refused and never bills', async () => {
  const out = collect();
  let extractCalls = 0;
  const status = await youtubeCommand(['teach', TEACH_URL, '--paid'], {
    output: out.output,
    extractTeachSource: async () => {
      extractCalls += 1;
      return fixtureSource();
    },
  });

  assert.equal(status, 2);
  assert.equal(extractCalls, 0);
  assert.match(out.text(), /drop --paid/);
});
