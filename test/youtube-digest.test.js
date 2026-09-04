const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseDigestArgs,
  collectVideoBriefs,
  buildDigestPrompt,
  digestExperimentSlug,
  LEARNER_CHECK_FILL,
  LEARNER_SCORE_ZERO,
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

const NOW = '2026-08-15T15:00:00.000Z';
const TODAY = '2026-08-15';
const STUB_DIGEST = [
  '# what this week\'s videos changed',
  '',
  'Keep the local notes path as the default. TSMC prints at 2nm. From atris/wiki/briefs/youtube-in.md the week favors transcript-first briefs over cloud process.',
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

function assertDigestApplyClaimable(cwd, { date = TODAY, tokens = [] } = {}) {
  const packRel = `atris/experiments/${digestExperimentSlug(date)}`;
  const applyRel = `atris/wiki/briefs/digest-${date}.apply.md`;
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
  return { packRel, applyRel, sidecar, journal };
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
  assert.equal(printed.lines.filter((line) => line === ephemeralApplyMessage('digest')).length, 0);
  assert.doesNotMatch(printed.text(), /^check:/m);
  assert.equal(printed.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.deepEqual(
    printed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris experiments keep digest-2026-08-15'],
  );
  assert.ok(
    printed.lines.indexOf('digest filed: atris/wiki/briefs/digest-2026-08-15.md (2 briefs)')
      < printed.lines.indexOf('next: atris experiments keep digest-2026-08-15'),
  );
  assert.ok(
    printed.lines.indexOf('next: atris experiments keep digest-2026-08-15')
      < printed.lines.indexOf(LEARNER_SCORE_ZERO),
  );
  assert.doesNotMatch(printed.text(), /next: atris youtube watch tick/);
  const claim = assertDigestApplyClaimable(cwd, { tokens: ['2nm', 'what is 2nm?'] });
  assert.equal(fs.existsSync(path.join(cwd, claim.packRel, 'measure.py')), true);

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
      '- [claimable] apply: atris/experiments/digest-2026-08-15. keep only if measure.py moves 0→1. scores 1 only when the fixture contains the check tokens.',
      '',
    ].join('\n'),
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments', 'digest-2026-08-15', 'measure.py')), true);
});

test('thin digest prints fill-this then watch-tick next', async () => {
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
  });
  const printed = collect();
  const thin = [
    '# what this week\'s videos changed',
    '',
    'Keep the local notes path as the default.',
    'Treat watch ticks as a feeder, not a decision.',
    'Do not spend credits until a brief names a customer store need.',
  ].join('\n');

  const status = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: printed.output,
    runner: () => thin,
  });

  assert.equal(status, 0);
  assert.match(printed.text(), /digest filed: atris\/wiki\/briefs\/digest-2026-08-15\.md \(1 briefs\)/);
  assert.equal(printed.lines.filter((line) => line === `check: ${LEARNER_CHECK_FILL}`).length, 1);
  assert.equal(printed.lines.includes(LEARNER_SCORE_ZERO), false);
  assert.equal(printed.lines.includes(ephemeralApplyMessage('digest')), false);
  assert.deepEqual(
    printed.text().split('\n').filter((line) => line.startsWith('next:')),
    ['next: atris youtube watch tick'],
  );
  assert.ok(
    printed.lines.indexOf(`check: ${LEARNER_CHECK_FILL}`)
      < printed.lines.indexOf('next: atris youtube watch tick'),
  );
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', 'digest-2026-08-15.apply.md')), false);
});

test('digestExperimentSlug uses the digest date', () => {
  assert.equal(digestExperimentSlug('2026-08-15'), 'digest-2026-08-15');
  assert.equal(digestExperimentSlug('2026-08-15T15:00:00.000Z'), 'digest-2026-08-15');
});

test('rich digest mints a measure.py that validate.py accepts and scores 0 or 1 honestly', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
  });
  const printed = collect();
  const status = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: printed.output,
    runner: () => STUB_DIGEST,
  });

  assert.equal(status, 0);
  assert.equal(printed.lines.filter((line) => line === LEARNER_SCORE_ZERO).length, 1);
  assert.match(printed.text(), /next: atris experiments keep digest-2026-08-15/);
  const packDir = path.join(cwd, 'atris', 'experiments', 'digest-2026-08-15');
  for (const name of ['program.md', 'measure.py', 'loop.py', 'reset.py', 'results.tsv']) {
    assert.equal(fs.existsSync(path.join(packDir, name)), true, name);
  }
  const program = fs.readFileSync(path.join(packDir, 'program.md'), 'utf8');
  assert.ok(program.length < 1200);
  assert.match(program, /2nm/);
  const measureSrc = fs.readFileSync(path.join(packDir, 'measure.py'), 'utf8');
  assert.match(measureSrc, /2nm/);

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
  const hit = scoreFixture('keep the 2nm node as the default print');
  assert.equal(hit.score, 1);

  const claim = assertDigestApplyClaimable(cwd, { tokens: ['2nm', 'what is 2nm?'] });
  const stub = spawnSync(pythonCmd, [path.join(packDir, 'measure.py')], {
    cwd: packDir,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_REPO_ROOT: cwd },
  });
  assert.equal(stub.status, 0, stub.stderr || stub.stdout);
  const stubPayload = JSON.parse(stub.stdout.trim().split('\n').pop());
  assert.equal(stubPayload.score, 0);
  assert.doesNotMatch(claim.sidecar, /2nm/i);
});

test('experiments keep refuses a minted digest pack at 0 and keeps after check tokens', async () => {
  assert.ok(pythonCmd, 'python3 is required to score the minted pack');
  const cwd = tempCwd();
  writeBrief(cwd, 'youtube-in.md', {
    date: TODAY,
    source: 'https://www.youtube.com/watch?v=in11111',
    title: 'in window',
  });
  const status = await youtubeCommand(['digest'], {
    cwd,
    now: NOW,
    output: () => {},
    runner: () => STUB_DIGEST,
  });

  assert.equal(status, 0);
  const packDir = path.join(cwd, 'atris', 'experiments', 'digest-2026-08-15');
  const applyPath = path.join(cwd, 'atris', 'wiki', 'briefs', 'digest-2026-08-15.apply.md');

  const refused = runExperimentsKeep(cwd, 'digest-2026-08-15');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /revert digest-2026-08-15: measure\.py stayed 0\. refuse keep\./);
  assert.doesNotMatch(`${refused.stdout}\n${refused.stderr}`, /next: atris youtube watch tick/);
  assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);

  fs.appendFileSync(applyPath, '\nkeep the 2nm node as the default print\n');
  const kept = runExperimentsKeep(cwd, 'digest-2026-08-15');
  assert.equal(kept.status, 0, kept.stderr || kept.stdout);
  assert.match(kept.stdout, /keep digest-2026-08-15: measure\.py moved 0→1/);
  assert.deepEqual(
    kept.stdout.split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    ['next: atris youtube watch tick']
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
  assert.doesNotMatch(printed.text(), /^check:/m);
  assert.equal(printed.text().includes(LEARNER_SCORE_ZERO), false);
  assert.equal(printed.text().includes(ephemeralApplyMessage('digest')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.apply.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
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
  assert.match(printed.text(), /rich digest writes one apply and a failing keep\/revert pack/);
  assert.equal(printed.text().includes('next:'), false);
  assert.doesNotMatch(printed.text(), /^check:/m);
  assert.equal(printed.text().includes(LEARNER_SCORE_ZERO), false);
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
  assert.doesNotMatch(failed.text(), /^check:/m);
  assert.equal(failed.text().includes(LEARNER_SCORE_ZERO), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.apply.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);

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
  assert.doesNotMatch(empty.text(), /^check:/m);
  assert.equal(empty.text().includes(LEARNER_SCORE_ZERO), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'wiki', 'briefs', `digest-${TODAY}.apply.md`)), false);
  assert.equal(fs.existsSync(path.join(cwd, 'atris', 'experiments')), false);
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
  assert.doesNotMatch(printed.text(), /^check:/m);
  assert.equal(printed.text().includes(LEARNER_SCORE_ZERO), false);
});
