const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseDigestArgs,
  collectVideoBriefs,
  buildDigestPrompt,
  youtubeCommand,
} = require('../commands/youtube');

const NOW = '2026-08-15T15:00:00.000Z';
const TODAY = '2026-08-15';
const STUB_DIGEST = [
  '# what this week\'s videos changed',
  '',
  'Keep the local notes path as the default. From atris/wiki/briefs/youtube-in.md the week favors transcript-first briefs over cloud process.',
  'Treat watch ticks as a feeder, not a decision. From atris/wiki/briefs/youtube-edge.md new channel videos should land as briefs before anyone debates them.',
  'Do not spend credits until a brief names a customer store need.',
  '',
  'contradictions or tensions',
  'Local notes want speed. Cloud process wants a stored knowledge record. Both can be true if the rail is chosen first.',
  '',
  'do next',
  '1. File one brief from the oldest unwatched subscribed channel.',
  '2. Run digest after the next three briefs land.',
  '3. Keep cloud process behind an explicit store request.',
].join('\n');

function tempCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-yt-digest-'));
}

function writeBrief(cwd, name, { date, source, title, body } = {}) {
  const dir = path.join(cwd, 'atris', 'wiki', 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    title || name.replace(/\.md$/, ''),
    '',
    date ? `date: ${date}` : 'date: missing',
  ];
  if (source) lines.push(`source: ${source}`);
  lines.push('', body || `${name} body`);
  fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`);
}

function collect() {
  const lines = [];
  return {
    lines,
    output: (line = '') => lines.push(String(line)),
    text: () => lines.join('\n'),
  };
}

function stubRunner(calls) {
  return (prompt) => {
    calls.push(prompt);
    return STUB_DIGEST;
  };
}

test('parseDigestArgs defaults to 7 days and accepts --days', () => {
  assert.deepEqual(parseDigestArgs([]), { help: false, days: 7 });
  assert.deepEqual(parseDigestArgs(['--days', '14']), { help: false, days: 14 });
  assert.deepEqual(parseDigestArgs(['--days=3']), { help: false, days: 3 });
});

test('window filtering by date header keeps only briefs inside the days window', () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-today.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=today11',
    title: 'today brief',
  });
  writeBrief(cwd, 'youtube-edge.md', {
    date: '2026-08-09',
    source: 'https://www.youtube.com/watch?v=edge099',
    title: 'edge brief',
  });
  writeBrief(cwd, 'youtube-old.md', {
    date: '2026-08-08',
    source: 'https://www.youtube.com/watch?v=old0088',
    title: 'old brief',
  });

  const rows = collectVideoBriefs({ cwd, now: NOW, days: 7 });
  assert.deepEqual(rows.map((row) => row.name), ['youtube-edge.md', 'youtube-today.md']);
  assert.ok(!rows.some((row) => row.name === 'youtube-old.md'));
});

test('digest- files and non-video files are skipped', () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
  });
  writeBrief(cwd, 'digest-2026-08-15.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=digest1',
    title: 'prior digest',
  });
  writeBrief(cwd, 'meeting-notes.md', {
    date: TODAY,
    title: 'not a video',
  });
  writeBrief(cwd, 'local-clip.md', {
    date: TODAY,
    source: '/tmp/clip.mp4',
    title: 'local file',
  });

  const rows = collectVideoBriefs({ cwd, now: NOW, days: 7 });
  assert.deepEqual(rows.map((row) => row.name), ['youtube-in.md']);
  const prompt = buildDigestPrompt(rows);
  assert.match(prompt, /filename: youtube-in\.md/);
  assert.match(prompt, /path: atris\/wiki\/briefs\/youtube-in\.md/);
  assert.doesNotMatch(prompt, /digest-2026-08-15/);
  assert.doesNotMatch(prompt, /meeting-notes/);
});

test('digest writes the output file with sources listed', async () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
    body: 'Ship local notes first.',
  });
  writeBrief(cwd, 'youtube-edge.md', {
    date: '2026-08-09',
    source: 'https://youtu.be/edge099',
    title: 'edge brief',
    body: 'Watch ticks feed briefs.',
  });
  const printed = collect();
  const prompts = [];

  const status = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: printed.output,
    runner: stubRunner(prompts),
  });

  assert.equal(status, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /filename: youtube-in\.md/);
  assert.match(prompts[0], /title: in window/);
  assert.match(prompts[0], /Ship local notes first/);
  assert.match(printed.text(), /digest filed: atris\/wiki\/briefs\/digest-2026-08-15\.md \(2 briefs\)/);
  assert.deepEqual(
    printed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch tick'],
  );

  const filed = fs.readFileSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'digest-2026-08-15.md'), 'utf8');
  assert.equal(filed.split('\n').slice(0, 3).join('\n'), [
    'date: 2026-08-15',
    'window: 7 days',
    'sources: atris/wiki/briefs/youtube-edge.md, atris/wiki/briefs/youtube-in.md',
  ].join('\n'));
  assert.match(filed, /# what this week's videos changed/);
  assert.ok(!filed.includes('\u2014'));
});

test('digest appends a claimable journal line', async () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
  });
  const journalPath = path.join(cwd, 'atris', 'logs', '2026', '2026-08-15.md');
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, '- already here');

  const status = await youtubeCommand(['digest', '--days', '7'], {
    cwd,
    now: new Date(NOW),
    output: () => {},
    runner: () => STUB_DIGEST,
  });

  assert.equal(status, 0);
  const journal = fs.readFileSync(journalPath, 'utf8');
  assert.equal(
    journal,
    [
      '- already here',
      '- [claimable] digest: what this week\'s videos changed -> atris/wiki/briefs/digest-2026-08-15.md',
      '',
    ].join('\n'),
  );
});

test('empty window is a no-op', async () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-old.md', {
    date: '2026-08-01',
    source: 'https://www.youtube.com/watch?v=old0001',
    title: 'too old',
  });
  const printed = collect();
  let ran = 0;

  const status = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: printed.output,
    runner: () => {
      ran += 1;
      return STUB_DIGEST;
    },
  });

  assert.equal(status, 0);
  assert.equal(ran, 0);
  assert.match(printed.text(), /no video briefs in the last 7 days/);
  assert.deepEqual(
    printed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube search " "'],
  );
  assert.equal(printed.text().includes('next: atris youtube watch tick'), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'logs')), false);
});

test('digest help lists the new usage', async () => {
  const printed = collect();
  const status = await youtubeCommand(['digest', '--help'], {
    output: printed.output,
    runner: () => {
      throw new Error('engine should not run for help');
    },
  });
  assert.equal(status, 0);
  assert.match(printed.text(), /atris youtube digest \[--days N\]/);
  assert.equal(printed.text().includes('next:'), false);
});

test('digest engine failure prints no next-step', async () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
  });
  const failed = collect();
  const failStatus = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: failed.output,
    runner: () => {
      throw new Error('digest engine failed');
    },
  });
  assert.equal(failStatus, 1);
  assert.match(failed.text(), /digest engine failed/);
  assert.equal(failed.text().includes('next:'), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.md`)), false);

  const empty = collect();
  const emptyStatus = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: empty.output,
    runner: () => '',
  });
  assert.equal(emptyStatus, 1);
  assert.match(empty.text(), /digest engine returned no text/);
  assert.equal(empty.text().includes('next:'), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.md`)), false);
});

test('digest parse error prints no next-step', async () => {
  const printed = collect();
  const status = await youtubeCommand(['digest', '--days', 'nope'], {
    output: printed.output,
    runner: () => {
      throw new Error('engine should not run for parse errors');
    },
  });
  assert.equal(status, 2);
  assert.match(printed.text(), /--days must be a positive integer/);
  assert.equal(printed.text().includes('next:'), false);
});
